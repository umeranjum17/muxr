// Open and type in an agent's terminal on a host that reads Herdr Core (core-terminal.md, jg-kile slice 7): the release APK on an
// owned emulator, paired to a real lab relay and a real lab host started with the lab-only
// --herdr-core-lab source, over a private lab Herdr Core. A shell runs in the core as the agent. Home's
// preview watches it (the terminal's size on the computer must not change), then the phone opens it,
// types `echo hi`, and the terminal on the computer must answer hi.
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
    let report = '';
    let failed = false;
    try { report = execFileSync('node', [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), emu.serial, dir, name], { encoding: 'utf8' }); }
    catch (cause) { report = `${cause.stdout ?? ''}${cause.stderr ?? ''}`; failed = true; }
    // The screenshot is the evidence; the view dumps only feed the visual lead check above.
    for (const suffix of ['.xml', '.compressed.xml']) rmSync(join(dir, `${name}${suffix}`), { force: true });
    // Layout of existing screens (the quick-actions bar, Home's usage card) is reported here, not gated: this lab proves
    // slice 7, and the judge still reads the captures for the claimed outcome. A check that could not run at all is a defect.
    const found = report.split('\n').filter((line) => /DEFECT/.test(line));
    for (const line of found) note(`visual note on ${name}: ${line.replace(/^DEFECT /, '').trim()}`);
    if (failed && found.length === 0) defects.push(`visual check on ${name} did not run: ${report.trim().slice(0, 240) || 'it exited with an error'}`);
    else note(`captured ${name}`);
};
const relaunch = async () => {
    await adb('shell', 'am', 'force-stop', PKG);
    await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    await sleep(6000);
};
// The agent's card on Home: a node that names it and carries the status word.
const AGENT = /(lab-agent|lab agent|fix[- ]login)/i;
const showing = (word) => (xml) => [...xml.matchAll(/<node\s[^>]*>/g)].some(([n]) => AGENT.test(n) && new RegExp(`\\b${word}\\b`).test(n));

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
    // Larger text so the preview tile and the terminal read clearly in the captures (reset in the finally below).
    await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.5');
    if (!paired) defects.push('Home never opened after pairing');

    // A stand-in agent that is a plain shell, so the phone's typed line has a program to answer it.
    api = await core.connect();
    const run = await api.call('terminal.run', {
        argv: ['sh', '-c', "printf 'lab agent ready\\ncomputer: Herdr Core lab\\nuser: Umer\\ntask: Fix login\\nstatus: waiting for a command\\n'; exec sh"], cwd: core.env.HOME, name: 'lab-agent',
        labels: { 'herdr.space': 'pockit', 'herdr.tab': 'fix-login', 'muxr.kind': 'fake-agent' }, keep: true,
    });
    note(`started ${run.address} in the lab core`);
    const sizeOnComputer = async () => { const t = await api.call('terminal.get', { terminal: run.address }); return `${t.cols}x${t.rows}`; };
    const readScreen = async () => (await api.call('terminal.read', { terminal: run.address, lines: 50 })).text ?? '';
    const sizeBefore = await sizeOnComputer();
    note(`terminal size on the computer before the phone looks: ${sizeBefore}`);
    await sleep(1000);

    const listed = await waitFor(showing('(Idle|Starting|Working|Done)'), 60);
    note(`Home lists the agent: ${listed}`);
    if (!listed) defects.push('Home never listed the Herdr Core agent');

    const dir = join(evidence, 'native');
    mkdirSync(dir, { recursive: true });
    // Home's card watches the terminal (a preview): it must not resize it.
    await sleep(5000);
    const sizeWithPreview = await sizeOnComputer();
    note(`terminal size on the computer with Home's preview watching: ${sizeWithPreview}`);
    if (sizeWithPreview !== sizeBefore) defects.push(`the preview resized the terminal: ${sizeBefore} -> ${sizeWithPreview}`);
    // No capture yet: the judged shots are taken after the line is typed, so each one can show hi.
    note(`the Home preview left the terminal's size alone: ${sizeWithPreview === sizeBefore} (${sizeBefore} before, ${sizeWithPreview} with the preview)`);

    // Android asks once for notifications: answer it so it never covers the terminal.
    await tap(/Don.t allow/, 6);
    // Open the agent's terminal and type a line.
    note(`tapped the agent card: ${await tap(AGENT, 30)}`);
    await sleep(6000);
    // The terminal itself takes the keys (the composer below it sends a prompt, which is a later slice).
    await adb('shell', 'input', 'tap', '540', '700');
    await sleep(1500);
    await adb('shell', 'input', 'text', 'echo%shi');
    await sleep(500);
    await adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
    let echoed = false;
    for (let i = 0; i < 15 && !echoed; i += 1) {
        await sleep(1000);
        echoed = /(^|\n)hi\s*(\n|$)/.test(await readScreen());
    }
    note(`the computer's terminal shows the typed line answered with "hi": ${echoed}`);
    if (!echoed) defects.push('the line typed on the phone never reached the terminal on the computer');
    // Close the keyboard first: with it up the quick-actions control sits over the terminal surface.
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(2000);
    cell(dir, 'terminal-typed-hi');
    const sizeAfter = await sizeOnComputer();
    note(`terminal size on the computer with the phone's terminal open: ${sizeAfter} (the phone's own terminal takes its own size; only the preview must leave it alone)`);
    // Back to Home (the first Back may only close the keyboard), then let its card read the screen again.
    for (let i = 0; i < 3; i += 1) {
        await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await sleep(2000);
        if (/Plan, ask, build/.test(await dump())) break;
    }
    // Home's two promo cards run under the navigation bar; answer them so the capture is the Live tile and the composer.
    for (let i = 0; i < 3; i += 1) {
        if (!(await tap(/Not now|Maybe later|Dismiss/, 4))) break;
        await sleep(1200);
    }
    await sleep(8000);
    const sizeBack = await sizeOnComputer();
    cell(dir, 'home-preview-after-hi');
    // The tile is small on a phone: a 2.5x crop of it, taken from the same screenshot, so its text can be read.
    try {
        execFileSync('magick', [join(dir, 'home-preview-after-hi.png'), '-crop', '800x420+40+580', '+repage', '-filter', 'Lanczos', '-resize', '250%', join(dir, 'home-preview-after-hi-zoom.png')]);
        note('captured home-preview-after-hi-zoom (the Live tile, enlarged, after hi was typed)');
        // The merge card keeps five evidence files at most: the enlarged tile stands for the full screenshot.
        rmSync(join(dir, 'home-preview-after-hi.png'), { force: true });
    } catch (cause) { defects.push(`could not crop the Home preview: ${cause.message}`); }
    note(`terminal size on the computer after the phone left it, preview watching again: ${sizeBack}`);

    for (const at of [evidence, dir]) {
        writeFileSync(join(at, 'steps.json'), `${JSON.stringify({
            target: { version: `this checkout's host, built from it, on a lab Herdr Core, with the released muxr app` },
            start: 'fresh app data on an Android emulator; a lab relay and host started with --herdr-core-lab over a private lab Herdr Core',
            steps: [
                'open the muxr://pair link from the lab host and tap Pair',
                'start a shell in the lab Herdr Core as an agent and watch Home (its preview watches the terminal)',
                'open the agent and type: echo hi',
                'read the same terminal from the computer side: it holds a line that says hi',
            ],
            result: `Typed on the phone, the terminal on the computer answered hi: ${echoed}. Size on the computer: before ${sizeBefore}, Home preview watching ${sizeWithPreview}, phone terminal open ${sizeAfter}, after leaving ${sizeBack}.`,
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
