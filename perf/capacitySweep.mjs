/**
 * Where the service breaks, and what fits in a RAM budget.
 *
 * The release gate answers "is this build safe to ship at the size we support".
 * This answers a different question: how big a herd can one machine serve
 * before either the phone or the host stops coping. It ramps the herd - panes,
 * agents, inline graphics - and for every step records what our own processes
 * cost in RSS and what the phone's JS thread, frames and memory did.
 *
 * Herdr is faked, so the herd stand-in's own memory is reported separately and
 * never counted against the budget: a real Herdr's cost is Herdr's business.
 * What is measured for the budget is our host and our relay.
 *
 *   node perf/capacitySweep.mjs --apk /tmp/app-release.apk
 *   node perf/capacitySweep.mjs --apk … --record docs/perf/capacity-0.1.25.json
 *   node perf/capacitySweep.mjs --apk … --seconds 90 --budget 4
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { startFakeStack } from './lib/fakeStack.mjs';
import { sampleServiceMemory, treeRssKb } from './lib/hostSignals.mjs';
import { pairPhone } from './lib/pairPhone.mjs';
import { appPid, clearLogcat, deviceReady, resetFrames, samplePhase, updateDepthErrors } from './lib/androidSignals.mjs';

const run = promisify(execFile);
const PKG = 'com.trymuxr.app';
const MAESTRO = ['mise', ['x', 'maestro@cli-2.7.0', '--', 'maestro']];

const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
};
const apk = flag('--apk');
const recordPath = flag('--record');
const seconds = Number(flag('--seconds') ?? 60);

/**
 * Each step doubles the herd. Agents are a fifth of the panes, which is the
 * shape a working desk has: a few agents, many shells.
 */
const STEPS = [
    { panes: 10, agents: 2 },
    { panes: 30, agents: 6 },
    { panes: 45, agents: 9 },
    { panes: 60, agents: 12 },
    { panes: 90, agents: 18 },
    { panes: 120, agents: 24 },
];

/**
 * A step passes when the phone stays usable and our own processes stay inside
 * the biggest budget we care about. Everything else is reported, not gated.
 */
const LIMITS = {
    jsBusyPercent: 60,
    frameStallSeconds: 30,
    serviceRssKb: 4 * 1024 * 1024,
    /** A herd nobody can see is a herd nobody can use. */
    herdVisibleMs: 90_000,
};
const BUDGETS_GB = [2, 4];

const report = { startedAt: new Date().toISOString(), seconds, steps: [], limits: LIMITS };
const mb = (kb) => Math.round((kb ?? 0) / 1024);

function maestro(flow, variables = {}) {
    const [bin, prefix] = MAESTRO;
    const declared = Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return new Promise((resolve) => {
        const child = spawn(bin, [...prefix, '--device', 'emulator-5554', 'test', ...declared, flow], {
            env: { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME ?? join(process.env.HOME, 'Android/Sdk') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = [];
        child.stdout.on('data', (chunk) => output.push(String(chunk)));
        child.stderr.on('data', (chunk) => output.push(String(chunk)));
        const deadline = setTimeout(() => child.kill('SIGTERM'), 600_000);
        child.once('close', (code) => {
            clearTimeout(deadline);
            resolve({ code: code ?? 1, output: output.join('') });
        });
    });
}

function hostRequestFailures(dataDir) {
    try {
        const journal = JSON.parse(readFileSync(join(dataDir, 'diagnostics.json'), 'utf8'));
        const requests = (journal.events ?? []).filter((event) => event.event === 'client.request');
        return {
            total: requests.length,
            rejected: requests.filter((event) => event.outcome !== 'ok').length,
            slowest: requests.reduce((peak, event) => Math.max(peak, event.durationMs ?? 0), 0),
        };
    } catch {
        return { total: 0, rejected: 0, slowest: 0 };
    }
}

async function measure(step) {
    const stack = await startFakeStack({
        panes: step.panes,
        agents: step.agents,
        titleChurnHz: 2,
        terminalBytesPerSecond: 4096,
        graphicsFrameHz: 4,
    });
    try {
        await run('adb', ['shell', 'pm', 'clear', PKG], { timeout: 120_000 }).catch(() => undefined);
        const paired = await pairPhone({ stack, maestro, flow: 'perf/flows/pair.yaml' });
        if (!paired.ok) return { ...step, error: paired.why };
        const herdVisibleMs = paired.herdVisibleMs;
        // The emulator's screen must stay on, or a sampled window measures a
        // dozing device instead of a working one.
        await run('adb', ['shell', 'svc', 'power', 'stayon', 'true'], { timeout: 30_000 }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        await clearLogcat();
        await resetFrames(PKG);

        const [phone, service] = await Promise.all([
            samplePhase({ pkg: PKG, seconds }),
            sampleServiceMemory({ pids: stack.pids, seconds }),
        ]);
        return {
            ...step,
            sessions: stack.world.panes.length,
            herdVisibleMs,
            phone: {
                jsBusyPercent: phone.jsBusyPercent,
                fps: phone.fps,
                pssFirstKb: phone.pssFirstKb,
                pssLastKb: phone.pssLastKb,
                restarts: phone.restarts,
                frameStallSeconds: phone.frameStallSeconds,
                updateDepthErrors: await updateDepthErrors(),
                alive: (await appPid(PKG)) !== undefined,
            },
            service,
            herdStandInRssKb: treeRssKb(stack.herdrPid),
            requests: hostRequestFailures(stack.dataDir),
        };
    } finally {
        stack.stop();
    }
}

function verdict(result) {
    if (result.error !== undefined) return { ok: false, why: result.error };
    const reasons = [];
    if (result.phone.jsBusyPercent === undefined) reasons.push('the JS thread never sampled');
    else if (result.phone.jsBusyPercent > LIMITS.jsBusyPercent) reasons.push(`JS thread ${result.phone.jsBusyPercent}%`);
    if (result.phone.frameStallSeconds >= LIMITS.frameStallSeconds) reasons.push(`frames stalled ${result.phone.frameStallSeconds}s`);
    if (!result.phone.alive) reasons.push('the app died');
    if (result.phone.updateDepthErrors > 0) reasons.push(`${result.phone.updateDepthErrors} update-depth errors`);
    if (result.herdVisibleMs > LIMITS.herdVisibleMs) reasons.push(`the herd took ${Math.round(result.herdVisibleMs / 1000)}s to reach the phone`);
    if (result.service.peakTotalKb > LIMITS.serviceRssKb) reasons.push(`service ${mb(result.service.peakTotalKb)} MB`);
    if (result.requests.rejected > 0) reasons.push(`${result.requests.rejected} rejected host request(s)`);
    return { ok: reasons.length === 0, why: reasons.join(', ') };
}

process.stdout.write('\n=== MUXR CAPACITY SWEEP ===\n\n');
if (!await deviceReady()) {
    process.stdout.write('FAIL: no adb device; start the emulator first\n');
    process.exit(1);
}
if (apk !== undefined) {
    await run('adb', ['install', '-r', apk], { timeout: 600_000 });
    process.stdout.write(`installed ${apk}\n`);
}
report.apk = apk;

for (const step of STEPS) {
    process.stdout.write(`\n--- ${step.panes} panes / ${step.agents} agents ---\n`);
    const result = await measure(step);
    const outcome = verdict(result);
    report.steps.push({ ...result, ...outcome });
    if (result.error !== undefined) {
        process.stdout.write(`FAIL: ${result.error}\n`);
    } else {
        process.stdout.write(`phone: js ${result.phone.jsBusyPercent ?? '-'}%  fps ${result.phone.fps ?? '-'}`
            + `  pss ${mb(result.phone.pssFirstKb)} -> ${mb(result.phone.pssLastKb)} MB`
            + `  restarts ${result.phone.restarts}  stall ${result.phone.frameStallSeconds}s`
            + `  herd on screen after ${Math.round(result.herdVisibleMs / 1000)}s\n`);
        process.stdout.write(`service: host ${mb(result.service.peakByName.host)} MB + relay ${mb(result.service.peakByName.relay)} MB`
            + ` = ${mb(result.service.peakTotalKb)} MB peak   (herd stand-in ${mb(result.herdStandInRssKb)} MB)\n`);
        process.stdout.write(`host requests: ${result.requests.total}, ${result.requests.rejected} rejected, slowest ${result.requests.slowest} ms\n`);
        process.stdout.write(`${outcome.ok ? 'ok' : 'FAIL'}: ${outcome.ok ? 'within limits' : outcome.why}\n`);
    }
    // Two failures in a row is the ceiling; ramping further only burns time.
    const recent = report.steps.slice(-2);
    if (recent.length === 2 && recent.every((entry) => !entry.ok)) {
        process.stdout.write('\nstopping: two consecutive steps failed\n');
        break;
    }
}

const passed = report.steps.filter((step) => step.ok);
report.largestPassing = passed.at(-1) === undefined ? undefined : { panes: passed.at(-1).panes, agents: passed.at(-1).agents };
report.withinBudget = Object.fromEntries(BUDGETS_GB.map((gb) => {
    const fits = passed.filter((step) => step.service.peakTotalKb <= gb * 1024 * 1024).at(-1);
    return [`${gb}GB`, fits === undefined ? null : { panes: fits.panes, agents: fits.agents, serviceMb: mb(fits.service.peakTotalKb) }];
}));

process.stdout.write('\n=== RESULT ===\n');
for (const step of report.steps) {
    process.stdout.write(`${String(step.panes).padStart(4)} panes / ${String(step.agents).padStart(3)} agents:`
        + ` ${step.ok ? 'ok  ' : 'FAIL'} service ${String(mb(step.service?.peakTotalKb)).padStart(5)} MB`
        + `  js ${String(step.phone?.jsBusyPercent ?? '-').padStart(5)}%`
        + `${step.ok ? '' : `  (${step.why})`}\n`);
}
for (const [budget, fits] of Object.entries(report.withinBudget)) {
    process.stdout.write(fits === null
        ? `within ${budget}: nothing measured fits\n`
        : `within ${budget}: ${fits.panes} panes / ${fits.agents} agents at ${fits.serviceMb} MB\n`);
}

report.finishedAt = new Date().toISOString();
if (recordPath !== undefined) {
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nevidence: ${recordPath}\n`);
}
process.exit(0);
