#!/usr/bin/env node
/** Physical-phone smoke against a private host, without Maestro's OEM-blocked driver install. */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startFakeStack } from './lib/fakeStack.mjs';
import { setAndroidSerial, androidArgs } from './lib/deviceTarget.mjs';
import { LOAD } from './lib/scenario.mjs';
import { usagePlugins } from './fixtures/usageHome.mjs';
import { appPid, totalPssKb, framesRendered, resetGfx, jankReport } from './lib/androidSignals.mjs';
import { sha256 } from './lib/provenance.mjs';

const run = promisify(execFile);
const serial = process.argv[process.argv.indexOf('--serial') + 1];
const out = process.argv[process.argv.indexOf('--out') + 1];
const apk = process.argv[process.argv.indexOf('--apk') + 1];
if (!/^[-\w]+$/.test(serial ?? '') || !out || out.startsWith('--') || !apk || apk.startsWith('--')) {
    throw new Error('usage: node perf/phoneProbe.mjs --serial SERIAL --apk DEV_ID_RELEASE.apk --out REPORT.json');
}
setAndroidSerial(serial);
const pkg = 'app.muxr.crashperf.dev';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adb = async (...args) => (await run('adb', androidArgs(args), { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
const ui = async () => { await adb('shell', 'uiautomator', 'dump', '/sdcard/muxr-perf-ui.xml'); return adb('shell', 'cat', '/sdcard/muxr-perf-ui.xml'); };
function position(xml, pattern, attribute = 'text') {
    for (const node of xml.matchAll(/<node\s[^>]*\/>/g)) {
        const value = new RegExp(`${attribute}="([^"]*)"`).exec(node[0])?.[1];
        if (!value || !pattern.test(value)) continue;
        const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node[0]);
        if (bounds) return [Math.round((+bounds[1] + +bounds[3]) / 2), Math.round((+bounds[2] + +bounds[4]) / 2)];
    }
}
async function tap(pattern, attribute = 'text', optional = false) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const point = position(await ui(), pattern, attribute);
        if (point) { await adb('shell', 'input', 'tap', ...point.map(String)); return true; }
        await sleep(500);
    }
    if (!optional) throw new Error(`could not find ${pattern}`);
    return false;
}
async function wait(pattern, seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const xml = await ui();
        if (/Show live agent updates\?|Keep muxr connected in the background\?/.test(xml)) {
            await tap(/^CANCEL$/);
            continue;
        }
        if (pattern.test(xml)) return xml;
        await sleep(1000);
    }
    throw new Error(`phone did not show ${pattern}`);
}
async function sample(label) {
    const pid = await appPid(pkg);
    const result = { label, elapsedSeconds: Math.round((Date.now() - report.started) / 1000), pid,
        pssKb: pid ? await totalPssKb(pid) : null, frames: await framesRendered(pkg) };
    report.samples.push(result);
    return result;
}
const report = { startedAt: new Date().toISOString(), started: Date.now(), serial, pkg, samples: [], visits: [], outcome: 'inconclusive' };
let stack, pairing;
try {
    const remote = /^package:(\/[^\s]+\.apk)/m.exec(await adb('shell', 'pm', 'path', pkg))?.[1];
    if (!remote) throw new Error(`${pkg} not installed`);
    const scratch = mkdtempSync(join(tmpdir(), 'muxr-phone-probe-'));
    try {
        const pulled = join(scratch, 'installed.apk');
        await adb('pull', remote, pulled);
        report.apkSha256 = sha256(apk);
        if (sha256(pulled) !== report.apkSha256) throw new Error('installed dev-ID APK differs from candidate');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    if (!process.argv.includes('--fresh-install')) await adb('shell', 'pm', 'clear', pkg);
    stack = await startFakeStack({ ...LOAD, setupPlugins: usagePlugins(process.cwd()) });
    report.load = LOAD;
    report.relayPort = stack.relayPort;
    pairing = await stack.mintPairing();
    if (!pairing.code) throw new Error('no lab pairing offer');
    const startedPair = Date.now();
    await adb('shell', 'monkey', '-p', pkg, '1');
    await wait(/Other ways to connect|Enter pairing string/, 25);
    await tap(/^Other ways to connect$/);
    await tap(/^Enter pairing string$/);
    await tap(/^wss?:\/\/your-relay|^Pairing string$/, 'text', true);
    if (!(await tap(/^Pairing string$/, 'content-desc', true))) throw new Error('pairing input not accessible');
    await adb('shell', 'input', 'text', pairing.code).catch(() => { throw new Error('ADB could not enter pairing offer'); });
    await adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
    await wait(/THIS PHONE WILL BE ABLE TO/, 25);
    await adb('shell', 'input', 'swipe', '530', '1800', '530', '800', '350');
    await tap(/^Pair$/);
    await wait(/Pair with .*\?/, 10);
    await tap(/^PAIR$/);
    const pairDeadline = Date.now() + 100_000;
    let connected = false;
    while (Date.now() < pairDeadline) {
        const xml = await ui();
        if (/Allow .* to send you notifications/.test(xml)) await tap(/^Don't allow$/);
        else if (/Keep muxr connected in the background/.test(xml)) await tap(/^CANCEL$/);
        else if (/Compare the two words/.test(xml)) {
            if (!pairing.consentWords || !xml.includes(pairing.consentWords)) throw new Error('phone consent words differ from lab host');
            await tap(/^OK$/);
        } else if (/text="connected"/.test(xml)) { connected = true; break; }
        else await sleep(1000);
    }
    if (!connected) throw new Error('pairing did not reach connected Home');
    report.pairMs = Date.now() - startedPair;
    pairing.release(); pairing = undefined;
    process.stdout.write(`paired after ${report.pairMs} ms\n`);
    await resetGfx(pkg);
    await sample('connected home');
    await wait(/text="connected"/, 20);
    const panes = stack.world.panes.filter((pane) => !pane.agent_status).slice(0, 8);
    for (const pane of panes) {
        const started = Date.now();
        await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `muxr-dev:///session/${encodeURIComponent(`shell:${pane.pane_id}`)}`, pkg);
        const screen = await wait(/content-desc="Terminal surface"/, 15);
        await adb('shell', 'input', 'swipe', '540', '1300', '540', '500', '300');
        await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await wait(/text="connected"/, 20);
        report.visits.push({ pane: pane.pane_id, ms: Date.now() - started, terminalShown: screen.includes('content-desc="Terminal surface"') });
        await sample(`home after ${pane.pane_id}`);
    }
    await sleep(30_000);
    await sample('settled home');
    report.jank = await jankReport(pkg, { hz: 60 });
    report.outcome = report.visits.length === 8 && report.visits.every((visit) => visit.terminalShown)
        && report.samples.every((entry) => entry.pid && entry.pssKb) ? 'pass' : 'fail';
} catch (error) {
    report.outcome = 'fail';
    report.error = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${report.error}\n`);
} finally {
    pairing?.release();
    stack?.stop();
    report.finishedAt = new Date().toISOString();
    delete report.started;
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
if (report.outcome !== 'pass') process.exitCode = 1;
