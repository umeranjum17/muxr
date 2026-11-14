// Start, prompt and stop an agent on Herdr Core (core-start-stop.md, jg-kile slice 6): the release APK
// on an owned emulator, paired to a real lab relay and a real lab host started with the lab-only
// --herdr-core-lab source over a private lab Herdr Core. On the phone: New agent starts a Pi
// stand-in in a folder, a prompt is sent, Home shows Working then Done, and Stop agent removes it.
// The agent must carry the herdr.space and herdr.tab labels the host wrote: the journey reads them
// from the Core itself and fails on the space when it is missing: removing the host's herdr.space
// write (launchLabels in herdrCoreAgents.ts) ends the journey with `DEFECT the agent has no herdr.space`.
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
const AGENT = /(\bPi\b|\bt1\b|fix-login)/i;
const AGENT_CARD = /content-desc="[^"]*(\bPi\b|fix-login)[^"]*"[^>]*clickable="true"|clickable="true"[^>]*content-desc="[^"]*(\bPi\b|fix-login)/i;
// A relaunch can reopen the agent screen; step back until Home (its Right now card and prompt box) shows.
const goHome = async () => {
    for (let i = 0; i < 4; i += 1) {
        if (/Plan, ask, build|Right now/.test(await dump())) return;
        await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await sleep(1500);
    }
    // Backed out of the app: open it again.
    await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    await sleep(5000);
};
const observed = [];
const cardText = (xml, word) => [...xml.matchAll(/<node\s[^>]*>/g)].map(([n]) => n).filter((n) => AGENT.test(n) && new RegExp(`\\b${word}\\b`).test(n)).map((n) => (n.match(/content-desc="([^"]*)"/) ?? [])[1]).find((t) => t) ?? '';
const showing = (word) => (xml) => [...xml.matchAll(/<node\s[^>]*>/g)].some(([n]) => AGENT.test(n) && new RegExp(`\\b${word}\\b`).test(n));
const CELLS = [['270', '640', '2.0', 'dark']];


let stack;
let api;
let finished = false;
const scratch = join(process.env.MUXR_LAB_SCRATCH ?? `${process.env.HOME}/.cache/fms/cstart`, 'agent');
try {
    await adb('install', '-r', apk).catch(async (cause) => {
        if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(cause.stderr))) throw cause;
        await adb('uninstall', PKG);
        await adb('install', apk);
    });
    note('installed release APK');
    await adb('shell', 'pm', 'clear', PKG);
    // A earlier run can leave the large display scale on the emulator; the pairing sheet then hides Pair.
    for (const args of [['wm', 'size', 'reset'], ['wm', 'density', 'reset'], ['settings', 'put', 'system', 'font_scale', '1.0']]) await adb('shell', ...args).catch(() => undefined);
    // The notification question would cover Home and the open agent; answer it before the app asks.
    await adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS').catch(() => undefined);

    // The stand-in Pi: reports status the way Claude and Codex do (OSC 7501), works on each line it
    // is sent until `release` appears. The host starts it for the Pi kind (MUXR_HERDR_CORE_LAB_AGENT).
    mkdirSync(scratch, { recursive: true });
    const release = join(scratch, 'release');
    const folder = join(scratch, 'fix-login');
    mkdirSync(folder, { recursive: true });
    rmSync(release, { force: true });
    const agent = join(scratch, 'stand-in-pi.sh');
    writeFileSync(agent, [
        '#!/bin/sh',
        "s(){ printf '\\033]7501;state=%s:app=pi\\033\\\\' \"$1\"; }",
        's idle',
        'while IFS= read -r line; do',
        '  s working',
        `  while [ ! -f ${release} ]; do sleep 0.3; done`,
        '  s done',
        'done',
        '',
    ].join('\n'));
    chmodSync(agent, 0o755);

    stack = await startFakeStack({ panes: 1, agents: 0, hostOnHerdrCore: true, coreAgent: agent });
    const core = stack.herdrCore;
    note(`lab stack: relay ${stack.relayPort}, host pid ${stack.pids.host}, relay pid ${stack.pids.relay}, lab Herdr Core pid ${core.pid} (HC_SESSION ${core.session})`);
    for (const args of [['svc', 'power', 'stayon', 'true'], ['input', 'keyevent', 'KEYCODE_WAKEUP'], ['wm', 'dismiss-keyguard']]) await adb('shell', ...args).catch(() => undefined);
    const pairing = await stack.mintPairing();
    const link = /^(muxr|https?):/.test(pairing.code) ? pairing.code : `muxr://pair#${pairing.code}`;
    await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
    const PAIR = /(text|content-desc)="Pair"[^>]*clickable="true"|clickable="true"[^>]*(text|content-desc)="Pair"|text="Pair"/;
    let pairTapped = await tap(PAIR, 90);
    if (!pairTapped) {
        // A slow first start can swallow the link; keep what the screen showed and send the link again.
        writeFileSync(join(evidence, 'pair-missed.xml'), await dump());
        await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
        pairTapped = await tap(PAIR, 150);
    }
    note(`tapped Pair: ${pairTapped}`);
    const paired = await waitFor((xml) => /App \d+\.\d+\.\d+/.test(xml) || /Right now|Spaces|Computers/.test(xml), 180);
    pairing.release();
    if (!paired) defects.push('Home never opened after pairing');
    api = await core.connect();
    const terminals = async () => (await api.call('terminal.list', {})).terminals;
    const snap = async (name) => { const xml = await dump(); writeFileSync(join(evidence, `${name}.xml`), xml); return xml; };

    // New agent: Home -> Start an agent -> Pi -> the folder -> Start.
    note(`tapped Start an agent: ${await tap(/Start an agent/, 40)}`);
    await snap('new-agent-open');
    note(`chose Pi: ${await tap(/Pi, /, 30)}`);
    await snap('new-agent-pi');
    note(`typed the folder: ${await tap(/EditText/, 20)}`);
    await adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END');
    for (let i = 0; i < 80; i += 1) await adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
    await adb('shell', 'input', 'text', folder.replace(/ /g, '%s'));
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await snap('new-agent-folder');
    // On a tall phone the Start button sits below the sheet's fold: scroll it into view first.
    await adb('shell', 'input', 'swipe', '540', '1900', '540', '700', '300');
    await sleep(1000);
    await snap('new-agent-scrolled');
    note(`tapped Start: ${await tap(/text="Start Pi/, 20)}`);

    // The host asked Core to run it: one terminal, carrying the space and the tab.
    let mine;
    for (let i = 0; i < 40 && mine === undefined; i += 1) {
        mine = (await terminals()).find((t) => t.labels?.['muxr.kind'] === 'pi');
        if (mine === undefined) await sleep(500);
    }
    if (mine === undefined) defects.push('Core never got the agent the phone started');
    else {
        note(`Core runs ${mine.address} with labels ${JSON.stringify(mine.labels)}`);
        if (mine.labels['herdr.space'] !== 'fix-login') defects.push(`the agent has no herdr.space (labels ${JSON.stringify(mine.labels)})`);
        if (mine.labels['herdr.tab'] === undefined) defects.push('the agent has no herdr.tab');
    }
    await sleep(8000);
    await tap(/Don.t allow/, 6);
    await snap('session-open');

    // Prompt: type in the open agent's composer and send. The stand-in reports Working on its line.
    note(`tapped the prompt box: ${await tap(/Prompt/, 60)}`);
    await adb('shell', 'input', 'text', 'fix%sthe%slogin%sbug');
    await snap('prompt-typed');
    note(`sent the prompt: ${await tap(/content-desc="Send/, 10)}`);
    const coreWord = async () => (await terminals()).find((t) => t.address === mine?.address)?.status?.state ?? 'none';
    let word = 'none';
    for (let i = 0; i < 40 && word !== 'working'; i += 1) { word = await coreWord(); if (word !== 'working') await sleep(500); }
    note(`Core says the agent is ${word}`);
    if (word !== 'working') defects.push(`the prompt never reached the agent (Core says ${word})`);

    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await tap(/content-desc="Back"/, 4);
    await sleep(3000);
    await snap('home-after-prompt');
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
            await tap(/Don.t allow/, 4);
            await goHome();
            if (!await waitFor(showing(word), 40)) defects.push(`${state} ${dp}/${font}/${theme}: Home never read "${word}" on the agent's card`);
            cell(dir, `home-${state}-${dp}-${font}-${theme}`);
        }
    };
    if (working) await captureState('working', 'Working');

    writeFileSync(release, 'go\n');
    await goHome();
    const done = await waitFor((xml) => { const ok = showing('Done')(xml); if (ok) observed.push(`Done: Home card read "${cardText(xml, 'Done')}"`); return ok; }, 40);
    note(`Home shows Done: ${done}`);
    if (!done) defects.push('Home never showed the agent Done');
    if (done) await captureState('done', 'Done');

    // Stop: open the agent, Stop agent, confirm. Core must lose the terminal and Home the card.
    await snap('home-before-stop');
    await goHome();
    note(`opened the agent: ${await tap(AGENT_CARD, 20)}`);
    note(`opened its panes: ${await tap(/content-desc="Pi\. pi · t1\. Open panes"/, 20)}`);
    note(`tapped Close Pi: ${await tap(/content-desc="Close Pi"/, 20)}`);
    await snap('stop-asked');
    await tap(/text="(Stop|Stop agent|Close|Close Pi|Yes)"/, 6);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i += 1) { gone = !(await terminals()).some((t) => t.address === mine?.address); if (!gone) await sleep(500); }
    note(`Core no longer holds the agent: ${gone}`);
    if (!gone) defects.push('Stop agent left the terminal in Core');
    await snap('after-stop');
    for (const at of [evidence, dir]) {
        writeFileSync(join(at, 'steps.json'), `${JSON.stringify({
            target: { version: `this checkout's host, built from it, on a lab Herdr Core, with the released muxr app` },
            start: 'fresh app data on an Android emulator; a lab relay and host started with --herdr-core-lab over a private lab Herdr Core',
            steps: [
                'open the muxr://pair link from the lab host and tap Pair',
                'New agent: choose Pi and a folder, tap Start',
                'send the prompt "fix the login bug"',
                'watch Home: the agent reads Working, then Done after it finishes',
                'open the agent and tap Stop agent',
            ],
            result: `The phone starts an agent that runs in Herdr Core under space ${mine?.labels?.['herdr.space']} and tab ${mine?.labels?.['herdr.tab']}, prompts it, sees Working then Done, and stops it. Observed on the live app: ${observed.join('; ')}`,
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
