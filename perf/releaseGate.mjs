/**
 * Release performance gate. One command, one exit code, real device.
 *
 * `yarn check` proves logic on any dev box. This proves the phone survives a
 * real herd, which is the only place the failures we shipped could be seen: a
 * release build whose JS thread saturated, threw `Maximum update depth
 * exceeded`, lost its runtime and showed a blank screen while every process
 * still looked alive.
 *
 * It is deliberately not in `runSuite`: it needs adb, an emulator and Maestro,
 * and it runs for about fifteen minutes.
 *
 * Relay, host and app are the real builds. Herdr is third party, so it is faked
 * at its own sockets: the load is a world this repo owns and sizes, the gate
 * needs no desk of its own, and nothing on this machine is touched. Real-Herdr
 * conformance is `yarn check`'s job (`checkHerdrE2E.mjs`).
 *
 * The app pairs freshly against the host started for the run every time. A
 * pre-paired emulator snapshot rots the first time a grant or key changes, and
 * a local-mode build would measure a bundle we do not ship.
 *
 *   yarn perf                            build, install, pair, load, measure
 *   yarn perf --apk <path>               measure an existing release APK
 *   yarn perf --record docs/perf/x.json  write evidence for the release input
 *   yarn perf --keep-load                leave the stack up for inspection
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { startFakeStack } from './lib/fakeStack.mjs';
import { tourEverySession } from './lib/deviceTour.mjs';
import { pairPhone } from './lib/pairPhone.mjs';
import {
    appPid,
    avdName,
    clearLogcat,
    deviceReady,
    framesRendered,
    jsThreadId,
    resetFrames,
    samplePhase,
    screenshot,
    updateDepthErrors,
} from './lib/androidSignals.mjs';

const run = promisify(execFile);

const PKG = 'com.trymuxr.app';
const AVD = 'muxr_sandbox';
const FLOWS = 'perf/flows';
const MAESTRO = ['mise', ['x', 'maestro@cli-2.7.0', '--', 'maestro']];

/**
 * Healthy after the current fixes is 20-26% JS thread, 58 fps, memory flat
 * within 20 MB. Failing was 96-100%, a dead runtime inside twenty seconds and
 * zero frames. The hard lines sit in that gap, wide enough that emulator noise
 * cannot cross them. Frame rate and jank are reported, never gated: under
 * swiftshader they measure the host, not the app.
 */
const LIMITS = {
    jsBusyPercent: 60,
    pssDriftKb: 100 * 1024,
    frameStallSeconds: 30,
    updateDepthErrors: 0,
    /** Growth across a full tour of every pane; one pane's images are not a leak. */
    tourGrowthKb: 150 * 1024,
    /** A herd nobody can see yet is a herd nobody can use. */
    herdVisibleMs: 90_000,
    /** A Herdr call the host waits on; anything near seconds is a stall. */
    hostRequestMs: 5_000,
};

/**
 * The herd the phone must survive. Thirty sessions is the breadth that matters:
 * the host caps title-only publishes at two per second per session, so the
 * inbound flood the app has to absorb comes from many panes, not a fast one.
 */
const LOAD = {
    panes: 30,
    agents: 6,
    titleChurnHz: 2,
    terminalBytesPerSecond: 4096,
    graphicsFrameHz: 4,
};

const PHASES = [
    { name: 'idle on the herd', seconds: 120, flow: undefined },
    { name: 'herd strip and tree soak', seconds: 120, flow: 'herdSoak.yaml' },
    { name: 'agent terminal and plugin navigation', seconds: 120, flow: 'herdNavigate.yaml' },
];

const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
};
const apkArg = flag('--apk');
const recordPath = flag('--record');
const keepLoad = args.includes('--keep-load');

const failures = [];
const report = { startedAt: new Date().toISOString(), phases: [], limits: LIMITS, load: LOAD };
let stack;

const ok = (message) => process.stdout.write(`ok: ${message}\n`);
const fail = (message) => {
    failures.push(message);
    process.stdout.write(`FAIL: ${message}\n`);
};

function finish(code) {
    if (stack !== undefined && !keepLoad) stack.stop();
    report.finishedAt = new Date().toISOString();
    report.failures = failures;
    report.passed = failures.length === 0;
    if (recordPath !== undefined) {
        mkdirSync(dirname(recordPath), { recursive: true });
        writeFileSync(recordPath, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`\nevidence: ${recordPath}\n`);
    }
    process.stdout.write(failures.length === 0
        ? '\nPASS: release performance gate\n'
        : `\nFAILED: ${failures.length} gate(s): ${failures.join('; ')}\n`);
    process.exit(code);
}

process.once('SIGINT', () => finish(130));
process.once('SIGTERM', () => finish(143));

/**
 * A flow run must never block this process: the sampler and the fake Herdr are
 * both driven from here, and a synchronous child would freeze the measurement
 * and every Herdr answer for the length of the flow.
 */
function maestro(flow, variables = {}) {
    const [bin, prefix] = MAESTRO;
    // Flow variables must be passed with -e; Maestro does not read them from
    // the process environment.
    const declared = Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return new Promise((resolve) => {
        const child = spawn(bin, [...prefix, '--device', 'emulator-5554', 'test', ...declared, join(FLOWS, flow)], {
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

// 1. Preflight. Every missing prerequisite is a named failure, never a timeout.
process.stdout.write('\n=== MUXR RELEASE PERF GATE ===\n\n');
if (!await deviceReady()) fail('no adb device; start the emulator first');
const avd = await avdName();
if (avd !== '' && avd !== AVD) process.stdout.write(`note: measuring on AVD ${avd}, not ${AVD}\n`);
const maestroVersion = spawnSync(MAESTRO[0], [...MAESTRO[1], '--version'], { encoding: 'utf8', timeout: 120_000 });
if ((maestroVersion.status ?? 1) !== 0) fail('maestro is unavailable');
if (failures.length > 0) finish(1);
report.avd = avd;
report.maestro = (maestroVersion.stdout ?? '').trim().split('\n').pop();
ok(`preflight: device ${avd || 'unknown'}, maestro ${report.maestro}`);

// 2. The APK under test. A release build, because the dev bundle's overhead
// hides the threshold the shipped app actually crosses.
let apk = apkArg;
if (apk === undefined) {
    process.stdout.write('building release APK (this takes a few minutes)...\n');
    const build = spawnSync('./gradlew', ['app:assembleRelease', '--no-daemon'], {
        cwd: 'apps/mobile/android',
        encoding: 'utf8',
        timeout: 1_800_000,
    });
    if ((build.status ?? 1) !== 0) {
        fail('release build failed; pass --apk <path> or set the signing env (ORG_GRADLE_PROJECT_release*)');
        finish(1);
    }
    apk = 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk';
}
report.apk = apk;
try {
    await run('adb', ['install', '-r', apk], { timeout: 600_000 });
} catch (cause) {
    fail(`adb install failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    finish(1);
}
// A cold app every run: pairing, catalog and caches all start from nothing.
await run('adb', ['shell', 'pm', 'clear', PKG], { timeout: 120_000 }).catch(() => undefined);
ok(`installed ${apk} and cleared app state`);

// 3. The stack the phone talks to: a relay and a host of this run's own, in a
// scratch directory, with a faked Herdr underneath them. Nothing on this
// machine is touched and the load is the same every time.
try {
    stack = await startFakeStack(LOAD);
} catch (cause) {
    fail(`could not start the stack: ${cause instanceof Error ? cause.message : String(cause)}`);
    finish(1);
}
ok(`herd up on relay :${stack.relayPort}: ${stack.world.panes.length} panes`
    + `, ${stack.world.agents.length} agents, titles at ${LOAD.titleChurnHz} Hz, graphics ${LOAD.graphicsFrameHz} Hz`);

// 4. Pair with a code minted for this run, then wait for the herd to actually
// be on screen. First-run prompts and a cold catalog make one attempt flaky in
// a way that says nothing about the build, so the helper retries once.
const paired = await pairPhone({ stack, maestro });
if (!paired.ok) {
    fail(paired.why);
    finish(1);
}
report.herdVisibleMs = paired.herdVisibleMs;
ok(`paired and the herd screen is visible after ${Math.round(paired.herdVisibleMs / 1000)}s`
    + `${paired.attempt > 1 ? ` (attempt ${paired.attempt})` : ''}`);
if (paired.herdVisibleMs > LIMITS.herdVisibleMs) fail(`the herd took ${Math.round(paired.herdVisibleMs / 1000)}s to reach the phone`);

// 5. Warm up, then measure. Warmup keeps first-launch bundle work and the
// catalog's first full sync out of the sampled windows.
await new Promise((resolve) => setTimeout(resolve, 30_000));
await clearLogcat();
await resetFrames(PKG);

for (const phase of PHASES) {
    let flowRun;
    const driving = phase.flow === undefined
        ? Promise.resolve()
        : maestro(phase.flow).then((result) => { flowRun = result; });
    const measured = await samplePhase({ pkg: PKG, seconds: phase.seconds });
    await driving;
    const entry = { ...phase, ...measured, flowExit: flowRun?.code };
    report.phases.push(entry);

    const busy = measured.jsBusyPercent;
    process.stdout.write(`\nphase "${phase.name}": js ${busy ?? 'not sampled'}%`
        + `  fps ${measured.fps ?? '-'}  pss ${measured.pssFirstKb ?? '-'} -> ${measured.pssLastKb ?? '-'} kB`
        + `  restarts ${measured.restarts}  stall ${measured.frameStallSeconds}s\n`);

    if (busy === undefined) fail(`${phase.name}: the JS thread never sampled, the runtime was down`);
    else if (busy > LIMITS.jsBusyPercent) fail(`${phase.name}: JS thread ${busy}% over ${LIMITS.jsBusyPercent}%`);
    else ok(`${phase.name}: JS thread ${busy}%`);

    if (measured.frameStallSeconds >= LIMITS.frameStallSeconds) {
        fail(`${phase.name}: no frames drawn for ${measured.frameStallSeconds}s`);
    }
    if ((measured.pssDriftKb ?? 0) > LIMITS.pssDriftKb) {
        fail(`${phase.name}: memory grew ${Math.round(measured.pssDriftKb / 1024)} MB`);
    }
    if (phase.flow !== undefined && flowRun?.code !== 0) {
        fail(`${phase.name}: ${phase.flow} did not complete`);
    }
}

// Every session the herd serves, opened and scrolled in turn. The list comes
// from the herd itself, never a hardcoded set, so a bigger world means a longer
// tour rather than a stale test.
const agentPanes = new Set(stack.world.agents.map((agent) => agent.pane_id));
const tour = await tourEverySession({
    pkg: PKG,
    // Shell panes only: an agent's session id is minted by the host and is not
    // something a deep link can guess. Agent terminals are the navigate flow's
    // job, which reaches them the way a person does.
    sessions: stack.world.panes
        .filter((pane) => !agentPanes.has(pane.pane_id))
        .map((pane) => ({ paneId: pane.pane_id })),
});
report.tour = tour;
process.stdout.write(`\ntour: ${tour.panes} panes, ${tour.opened} opened`
    + `  pss ${tour.pssFirstKb ?? '-'} -> ${tour.pssLastKb ?? '-'} kB (max ${tour.pssMaxKb ?? '-'})\n`);
if (tour.opened === 0) fail('the tour could not open a single terminal');
else ok(`toured ${tour.opened}/${tour.panes} panes`);
if (tour.pssGrowthKb > LIMITS.tourGrowthKb) {
    fail(`memory grew ${Math.round(tour.pssGrowthKb / 1024)} MB across the tour`);
} else {
    ok(`memory held across the tour (${Math.round(tour.pssGrowthKb / 1024)} MB)`);
}

// 6. Signals that only make sense across the whole run.
const depthErrors = await updateDepthErrors();
report.updateDepthErrors = depthErrors;
if (depthErrors > LIMITS.updateDepthErrors) fail(`React threw "Maximum update depth exceeded" ${depthErrors} time(s)`);
else ok('no React update-depth errors');

// The host's own account of what the phone asked for. This is the honest proof
// that terminals really attached, and it is where a stalled Herdr call shows up
// as a request that took seconds instead of milliseconds.
let requests = [];
try {
    const journal = JSON.parse(readFileSync(join(stack.dataDir, 'diagnostics.json'), 'utf8'));
    requests = (journal.events ?? []).filter((event) => event.event === 'client.request');
} catch (cause) {
    fail(`the host wrote no diagnostics journal: ${cause instanceof Error ? cause.message : String(cause)}`);
}
const attaches = requests.filter((event) => event.request === 'terminal.attach');
const rejected = requests.filter((event) => event.outcome !== 'ok');
const slowest = requests.reduce((peak, event) => Math.max(peak, event.durationMs ?? 0), 0);
report.hostRequests = {
    total: requests.length,
    attaches: attaches.length,
    rejected: rejected.map((event) => ({ request: event.request, outcome: event.outcome, code: event.code, durationMs: event.durationMs })),
    slowestMs: slowest,
};
process.stdout.write(`\nhost requests: ${requests.length} (${attaches.length} terminal attaches), slowest ${slowest} ms\n`);
if (attaches.filter((event) => event.outcome === 'ok').length === 0) fail('no terminal ever attached on the host');
else ok(`${attaches.filter((event) => event.outcome === 'ok').length} terminal attach(es) succeeded`);
if (rejected.length > 0) fail(`the host rejected ${rejected.length} request(s): ${rejected.map((event) => `${event.request}/${event.code ?? event.outcome}`).join(', ')}`);
else ok('the host rejected nothing');
if (slowest > LIMITS.hostRequestMs) fail(`a host request took ${slowest} ms`);

const pid = await appPid(PKG);
const tid = pid === undefined ? undefined : await jsThreadId(pid);
report.runtimeAlive = tid !== undefined;
if (tid === undefined) fail('the JS runtime is not alive at the end of the run');
else ok('the JS runtime survived the run');

const frames = await framesRendered(PKG);
report.framesRendered = frames;
if ((frames ?? 0) <= 0) fail('the app rendered no frames at all');

const shot = recordPath === undefined ? '/tmp/muxr-perf-final.png' : `${recordPath.replace(/\.json$/, '')}.png`;
await screenshot(shot).catch(() => undefined);
report.screenshot = shot;
report.commit = (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();

finish(failures.length === 0 ? 0 : 1);
