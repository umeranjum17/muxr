#!/usr/bin/env node
/**
 * A long URL an agent hard-wrapped over several rows opens whole, on the real
 * phone. The release app (lab dev id) pairs to the fake stack, whose terminal
 * prints one long npm URL with a real new line at every `cols` characters;
 * the last row is tapped, Open is chosen, and Chrome must be on the whole URL.
 *
 *   PHONE_SERIAL=<serial> PHONE_APK=<dev-id release apk> \
 *     ~/firstmate/config/fm-device-lock.sh <serial> \
 *     node .agents/skills/done-done-verify-pockit/features/terminalWrappedLinkLab.mjs <evidence-dir>
 *
 * Run it under the phone's keeper lock, from the repo root after `yarn build`.
 * Writes shot-*.png, chrome-tabs.json, events.json and done-done's
 * steps.json into <evidence-dir>.
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startFakeStack } from '../../../../perf/lib/fakeStack.mjs';
import { setAndroidSerial, androidArgs } from '../../../../perf/lib/deviceTarget.mjs';
import { apkIdentity } from '../../../../perf/lib/provenance.mjs';

const run = promisify(execFile);
const serial = process.env.PHONE_SERIAL;
const apk = process.env.PHONE_APK;
const evidence = process.argv[2];
if (!/^[-\w]+$/.test(serial ?? '') || !apk || !evidence?.startsWith('/')) {
    throw new Error('usage: PHONE_SERIAL=… PHONE_APK=… terminalWrappedLinkLab.mjs <absolute evidence dir>');
}
setAndroidSerial(serial);
const pkg = 'app.muxr.links1.dev';
// The npm URL of the report: long enough to need four or more rows on a phone.
const URL_PRINTED = 'https://www.npmjs.com/package/react?activeTab=readme&utm_source=muxr&utm_medium=terminal&utm_campaign=wrapped-link-398df0826dc8';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adb = async (...args) => (await run('adb', androidArgs(args), { timeout: args[0] === 'install' ? 180_000 : 30_000, maxBuffer: 32 * 1024 * 1024 })).stdout;
mkdirSync(evidence, { recursive: true });
const steps = [];
const note = (name, detail = {}) => { steps.push({ name, at: new Date().toISOString(), ...detail }); process.stdout.write(`${name}\n`); };
const shot = async (name) => {
    const { stdout } = await run('adb', androidArgs(['exec-out', 'screencap', '-p']), { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    writeFileSync(join(evidence, name), stdout);
};
const ui = async () => { await adb('shell', 'uiautomator', 'dump', '/sdcard/links1-ui.xml'); return adb('shell', 'cat', '/sdcard/links1-ui.xml'); };
function bounds(xml, pattern, attribute = 'text') {
    for (const node of xml.matchAll(/<node\s[^>]*>/g)) {
        const value = new RegExp(`${attribute}="([^"]*)"`).exec(node[0])?.[1];
        if (!value || !pattern.test(value)) continue;
        const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node[0]);
        if (b) return { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] };
    }
}
const center = (b) => [Math.round((b.left + b.right) / 2), Math.round((b.top + b.bottom) / 2)];
async function tap(pattern, attribute = 'text', optional = false) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const b = bounds(await ui(), pattern, attribute);
        if (b) { await adb('shell', 'input', 'tap', ...center(b).map(String)); return true; }
        await sleep(500);
    }
    if (!optional) throw new Error(`could not find ${pattern}`);
    return false;
}
async function wait(pattern, seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const xml = await ui();
        if (/Show live agent updates\?|Keep muxr connected in the background\?/.test(xml)) { await tap(/^CANCEL$/, 'text', true); continue; }
        if (pattern.test(xml)) return xml;
        await sleep(1000);
    }
    throw new Error(`phone did not show ${pattern}`);
}

let stack, pairing, installed = false, forwardPort;
try {
    const state = (await adb('get-state')).trim();
    const hardware = (await adb('shell', 'getprop', 'ro.hardware')).trim();
    if (serial.startsWith('emulator-') || state !== 'device' || /^(ranchu|goldfish|generic)$/i.test(hardware)) {
        note('target', { kind: 'emulator-or-offline', serial: '[redacted]' });
    } else {
        note('target', { kind: 'physical phone', model: (await adb('shell', 'getprop', 'ro.product.model')).trim() });
    }
    const identity = await apkIdentity(apk);
    if (identity.package !== pkg || identity.debuggable) throw new Error('PHONE_APK must be the non-debuggable lab dev-id release');
    // Only this lab's own dev id is ever removed or installed; com.trymuxr.app is untouched.
    await adb('uninstall', pkg).catch(() => {});
    await adb('install', apk);
    installed = true;
    note('installed', { package: pkg, apkSha256: identity.sha256 });

    stack = await startFakeStack({ panes: 4, agents: 1, titleChurnHz: 0, terminalBytesPerSecond: 1 });
    const printPath = stack.cellMetricsJsonl.replace(/\.cell-metrics\.jsonl$/, '.print-url');
    writeFileSync(printPath, `${URL_PRINTED}\n`);
    pairing = await stack.mintPairing();
    await adb('logcat', '-c');
    await adb('shell', 'monkey', '-p', pkg, '1');
    await wait(/Let’s connect|Other ways to connect|Enter pairing string/, 25);
    // The pairing link opens the app on its consent step, the way a scanned QR does.
    await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'muxr-dev://pair#${pairing.code}'`, pkg);
    await wait(/wants to pair with this phone/, 25);
    await tap(/^Pair$/);
    if (await tap(/^PAIR$/, 'text', true)) note('confirmed pair dialog');
    const deadline = Date.now() + 100_000;
    let connected = false;
    while (Date.now() < deadline) {
        const xml = await ui();
        if (/Allow .* to send you notifications/.test(xml)) await tap(/^Don't allow$/);
        else if (/Keep muxr connected in the background/.test(xml)) await tap(/^CANCEL$/);
        else if (/Compare the two words/.test(xml)) await tap(/^OK$/);
        else if (/text="connected"/.test(xml)) { connected = true; break; }
        else await sleep(1000);
    }
    if (!connected) throw new Error('pairing did not reach connected Home');
    pairing.release(); pairing = undefined;
    note('paired');

    const pane = stack.world.panes.find((row) => !stack.world.agents.some((agent) => agent.pane_id === row.pane_id));
    await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `muxr-dev:///session/${encodeURIComponent(`shell:${pane.pane_id}`)}`, pkg);
    let xml = await wait(/content-desc="Terminal surface"/, 20);
    await sleep(4000);
    xml = await ui();
    const surface = bounds(xml, /^Terminal surface$/, 'content-desc');
    if (!surface) throw new Error('no terminal surface bounds');
    // The grid the phone attached at is the last resize/attach the fake recorded.
    const metrics = readFileSync(stack.cellMetricsJsonl, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((m) => m.pane_id === pane.pane_id).pop();
    const { cols, rows } = metrics;
    const urlRows = Math.ceil(URL_PRINTED.length / cols);
    const cellW = (surface.right - surface.left) / cols;
    const cellH = (surface.bottom - surface.top) / rows;
    note('terminal', { cols, rows, urlRows, urlLength: URL_PRINTED.length, surface });
    if (urlRows < 3) throw new Error(`URL only wraps over ${urlRows} rows at ${cols} columns`);
    await shot('shot-1-wrapped-url.png');

    // Row 0 is the prompt line; the URL fills rows 1..urlRows. Tap the LAST
    // row, where the cut URL used to end, then choose Open from the link menu.
    const lastRow = urlRows;
    const lastLength = URL_PRINTED.length - (urlRows - 1) * cols;
    const x = Math.round(surface.left + (Math.min(2, lastLength - 1) + 0.5) * cellW);
    const y = Math.round(surface.top + (lastRow + 0.5) * cellH);
    await adb('shell', 'input', 'tap', String(x), String(y));
    await wait(/^Open$|text="Open"/, 10);
    await shot('shot-2-link-menu.png');
    note('tapped last row', { row: lastRow, x, y });
    await tap(/^Open$/);
    await sleep(8000);
    await shot('shot-3-destination.png');
    const top = (await adb('shell', 'dumpsys', 'activity', 'activities')).split('\n').filter((line) => /ResumedActivity/.test(line)).slice(0, 2).join('\n');
    note('opened', { resumed: top.trim() });

    // The browser's own tab list carries the whole address, query included.
    forwardPort = 9222 + (process.pid % 500);
    await adb('forward', `tcp:${forwardPort}`, 'localabstract:chrome_devtools_remote');
    const tabs = await (await fetch(`http://127.0.0.1:${forwardPort}/json/list`)).json();
    writeFileSync(join(evidence, 'chrome-tabs.json'), `${JSON.stringify(tabs.map((tab) => ({ type: tab.type, title: tab.title, url: tab.url })), null, 2)}\n`);
    const opened = tabs.find((tab) => tab.url === URL_PRINTED || tab.url.startsWith(URL_PRINTED));
    note('chrome tab', { found: opened !== undefined, url: opened?.url });
    if (opened === undefined) throw new Error(`Chrome has no tab on the whole URL: ${tabs.map((tab) => tab.url).join(' | ')}`);
    note('pass', { expected: URL_PRINTED });
} catch (error) {
    await shot('failure.png').catch(() => {});
    note('fail', { error: String(error instanceof Error ? error.message : error).replaceAll(serial, '[redacted]') });
    process.exitCode = 1;
} finally {
    try { pairing?.release(); } catch { /* gone */ }
    try { stack?.stop(); } catch (error) { note('cleanup-error', { error: String(error) }); }
    if (forwardPort !== undefined) await adb('forward', '--remove', `tcp:${forwardPort}`).catch(() => {});
    if (installed) await adb('uninstall', pkg).catch(() => {});
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME').catch(() => {});
    writeFileSync(join(evidence, 'events.json'), `${JSON.stringify(steps, null, 2)}\n`);
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version, package: pkg },
        start: 'the lab dev-id release app freshly installed and paired to a private stack whose shell pane shows one long npm URL, printed with a real new line at every column',
        steps: ['open the shell pane', 'tap the last row of the wrapped URL', 'choose Open in the link menu'],
        result: steps.some((step) => step.name === 'pass')
            ? 'Chrome opened on the whole URL, every row of it, not the last row\'s piece'
            : 'the whole URL did not open',
    }, null, 2)}\n`);
}
