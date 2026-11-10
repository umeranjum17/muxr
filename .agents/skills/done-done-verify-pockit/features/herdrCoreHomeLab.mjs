// Home on a host that reads Herdr Core (core-home-status.md, jg-kile slice 1): the release APK on an
// owned emulator, paired to a real lab relay and a real lab host started with the lab-only
// --herdr-core-lab source, over a private lab Herdr Core. A stand-in agent runs in the core and
// reports its status the way Claude and Codex do (OSC 7501). Home must show it Working while the
// agent works, then Done. An agent that stops reporting must fail the journey:
// CORE_HOME_SILENT=1 runs the same journey with a stand-in that never reports.
// Run from the repo root, after `yarn build`: node <this> <apk> <evidence-dir>;
// MUXR_LAB_AVD_HOME picks the emulator home.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const repo = process.cwd();
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { startFakeStack } = await import(join(repo, 'perf/lib/fakeStack.mjs'));
const { setAndroidSerial } = await import(join(repo, 'perf/lib/deviceTarget.mjs'));

const exec = promisify(execFile);
const [apk, evidence] = process.argv.slice(2).map((p) => resolve(p));
mkdirSync(evidence, { recursive: true });
const PKG = 'com.trymuxr.app';
const SILENT = process.env.CORE_HOME_SILENT === '1';
const log = [];
const note = (line) => { log.push(line); console.log(line); writeFileSync(join(evidence, 'journey.log'), `${log.join('\n')}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defects = [];

const emu = await bootOwnedEmulator({ name: 'mxcorehome', avdHome: process.env.MUXR_LAB_AVD_HOME, launcher: ['nice', '-n', '10'], extraArgs: ['-no-snapshot-load'] });
note(`emulator ${emu.serial} pid ${emu.pid}`);
// Before any stack starts: its adb reverse must name this emulator, never another attached device.
setAndroidSerial(emu.serial);
const adbOnce = (...args) => exec('adb', ['-s', emu.serial, ...args], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
const adb = (...args) => adbOnce(...args).catch(async () => { await sleep(3000); return adbOnce(...args); });
const dump = async () => {
    for (let i = 0; i < 5; i += 1) {
        try {
            await adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
            const { stdout } = await adb('shell', 'cat', '/sdcard/ui.xml');
            if (stdout.includes('<hierarchy')) return stdout;
        } catch { /* settling */ }
        await sleep(1000);
    }
    return '';
};
const waitFor = async (test, seconds) => {
    for (let i = 0; i < seconds; i += 2) {
        if (test(await dump())) return true;
        await sleep(2000);
    }
    return false;
};
const nodeBounds = (xml, pattern) => {
    const node = [...xml.matchAll(/<node\s[^>]*>/g)].map((m) => m[0]).find((n) => pattern.test(n));
    if (node === undefined) return undefined;
    const [, x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
    return { x: (x1 + x2) >> 1, y: (y1 + y2) >> 1 };
};
const tap = async (pattern, seconds = 30) => {
    for (let i = 0; i < seconds; i += 2) {
        const at = nodeBounds(await dump(), pattern);
        if (at !== undefined) { await adb('shell', 'input', 'tap', String(at.x), String(at.y)); return true; }
        await sleep(2000);
    }
    return false;
};
const cell = (dir, name) => {
    let report;
    try { report = execFileSync('node', [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), emu.serial, dir, name], { encoding: 'utf8' }); }
    catch (cause) { report = `${cause.stdout ?? ''}${cause.stderr ?? ''}`; }
    // The screenshot is the evidence; the view dumps only feed the visual lead check above.
    for (const suffix of ['.xml', '.compressed.xml']) rmSync(join(dir, `${name}${suffix}`), { force: true });
    note(`captured ${name}`);
};
const relaunch = async () => {
    await adb('shell', 'am', 'force-stop', PKG);
    await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    await sleep(6000);
};
// The agent's card on Home: a node that names it and carries the status word.
const AGENT = /(lab-agent|lab agent|fix[- ]login)/i;
const observed = [];
const cardText = (xml, word) => [...xml.matchAll(/<node\s[^>]*>/g)].map(([n]) => n).filter((n) => AGENT.test(n) && new RegExp(`\\b${word}\\b`).test(n)).map((n) => (n.match(/content-desc="([^"]*)"/) ?? [])[1]).find((t) => t) ?? '';
const showing = (word) => (xml) => [...xml.matchAll(/<node\s[^>]*>/g)].some(([n]) => AGENT.test(n) && new RegExp(`\\b${word}\\b`).test(n));
const CELLS = [['270', '640', '2.0', 'dark'], ['393', '440', '1.0', 'light']];

let stack;
let api;
let finished = false;
try {
    await adb('install', '-r', apk).catch(async (cause) => {
        if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(cause.stderr))) throw cause;
        await adb('uninstall', PKG);
        await adb('install', apk);
    });
    note('installed release APK');
    await adb('shell', 'pm', 'clear', PKG);

    // The host reads the lab Herdr Core, not the fake Herdr TUI: --herdr-core-lab, MUXR_HERDR_CORE_SOCKET.
    stack = await startFakeStack({ panes: 1, agents: 0, hostOnHerdrCore: true });
    const core = stack.herdrCore;
    note(`lab stack: relay ${stack.relayPort}, host pid ${stack.pids.host}, relay pid ${stack.pids.relay}, lab Herdr Core pid ${core.pid} (HC_SESSION ${core.session})`);
    for (const args of [['svc', 'power', 'stayon', 'true'], ['input', 'keyevent', 'KEYCODE_WAKEUP'], ['wm', 'dismiss-keyguard']]) await adb('shell', ...args).catch(() => undefined);
    const pairing = await stack.mintPairing();
    const link = /^(muxr|https?):/.test(pairing.code) ? pairing.code : `muxr://pair#${pairing.code}`;
    await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
    note(`tapped Pair: ${await tap(/(text|content-desc)="Pair"[^>]*clickable="true"|clickable="true"[^>]*(text|content-desc)="Pair"|text="Pair"/, 60)}`);
    const paired = await waitFor((xml) => /App \d+\.\d+\.\d+/.test(xml) || /Right now|Spaces|Computers/.test(xml), 90);
    pairing.release();
    if (!paired) defects.push('Home never opened after pairing');

    // The stand-in agent: reports status the way Claude and Codex do. It works until `release` appears.
    const release = join(core.env.HOME, 'release');
    const agent = join(core.env.HOME, 'fake-agent.sh');
    writeFileSync(agent, [
        '#!/bin/sh',
        SILENT ? 's(){ :; }' : "s(){ printf '\\033]7501;state=%s:app=fake-agent\\033\\\\' \"$1\"; }",
        's idle',
        'while IFS= read -r line; do',
        '  s working',
        `  while [ ! -f ${release} ]; do sleep 0.3; done`,
        '  s done',
        'done',
        '',
    ].join('\n'));
    chmodSync(agent, 0o755);
    api = await core.connect();
    const run = await api.call('terminal.run', {
        argv: [agent], cwd: core.env.HOME, name: 'lab-agent',
        labels: { 'herdr.space': 'pockit', 'herdr.tab': 'fix-login', 'muxr.kind': 'fake-agent' }, keep: true,
    });
    note(`started ${run.address} in the lab core${SILENT ? ' (silent: it never reports status)' : ''}`);
    await sleep(1000);

    // Live, with the app open the whole time: the card appears, then the status words follow it.
    const listed = await waitFor(showing('(Idle|Starting)'), 60);
    note(`Home lists the agent: ${listed}`);
    if (!listed) defects.push('Home never listed the Herdr Core agent');
    await api.call('terminal.send', { terminal: run.address, text: 'fix the login bug' });
    const working = await waitFor((xml) => { const ok = showing('Working')(xml); if (ok) observed.push(`Working: Home card read "${cardText(xml, 'Working')}"`); return ok; }, 40);
    note(`Home shows Working: ${working}`);
    if (!working) defects.push('Home never showed the agent Working');

    const dir = join(evidence, 'native');
    mkdirSync(dir, { recursive: true });
    const captureState = async (state, word) => {
        for (const [dp, density, font, theme] of CELLS) {
            await adb('shell', 'wm', 'size', '1080x2376');
            await adb('shell', 'wm', 'density', density);
            await adb('shell', 'settings', 'put', 'system', 'font_scale', font);
            await adb('shell', 'cmd', 'uimode', 'night', theme === 'dark' ? 'yes' : 'no');
            await relaunch();
            if (!await waitFor(showing(word), 40)) defects.push(`${state} ${dp}/${font}/${theme}: Home never read "${word}" on the agent's card`);
            cell(dir, `home-${state}-${dp}-${font}-${theme}`);
        }
    };
    if (working) await captureState('working', 'Working');

    writeFileSync(release, 'go\n');
    const done = await waitFor((xml) => { const ok = showing('Done')(xml); if (ok) observed.push(`Done: Home card read "${cardText(xml, 'Done')}"`); return ok; }, 40);
    note(`Home shows Done: ${done}`);
    if (!done) defects.push('Home never showed the agent Done');
    if (done) await captureState('done', 'Done');

    for (const at of [evidence, dir]) {
        writeFileSync(join(at, 'steps.json'), `${JSON.stringify({
            target: { version: `this checkout's host, built from it, on a lab Herdr Core, with the released muxr app` },
            start: 'fresh app data on an Android emulator; a lab relay and host started with --herdr-core-lab over a private lab Herdr Core',
            steps: [
                'open the muxr://pair link from the lab host and tap Pair',
                'start a stand-in agent in the lab Herdr Core and send it a prompt',
                'watch Home: the agent appears, then reads Working',
                'let the agent finish: Home reads Done',
                'read the same card at 270 dp font 2.0 dark and 393 dp font 1.0 light',
            ],
            result: `Home lists an agent that runs in Herdr Core and shows it Working, then Done. Observed on the live app: ${observed.join('; ')}`,
        }, null, 2)}\n`);
    }
    finished = true;
} finally {
    if (!finished) defects.push('the journey stopped before its end');
    api?.close();
    try { await adb('shell', 'wm', 'size', 'reset'); await adb('shell', 'wm', 'density', 'reset'); await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0'); } catch { /* emulator gone */ }
    const pids = stack ? [stack.pids.relay, stack.pids.host, stack.herdrCore?.pid].filter((pid) => pid !== undefined) : [];
    stack?.stop();
    note('stack stopped');
    await emu.stop();
    note('emulator stopped');
    for (const pid of pids) {
        for (let i = 0; i < 50 && spawnSync('ps', ['-p', String(pid)], { stdio: 'ignore' }).status === 0; i += 1) await sleep(200);
    }
    for (const defect of defects) note(`DEFECT ${defect}`);
    note(`done; defects: ${defects.length}`);
    process.exitCode = defects.length > 0 ? 1 : 0;
}
