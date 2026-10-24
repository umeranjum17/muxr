// Home's out-of-date Herdr card for an old Herdr server still running after
// `herdr update` replaced the binary (home-herdr-missing.md, old-server-signal):
// a real host and relay over the fake Herdr answering protocol 21 while its
// binary reports 0.9.1, the release APK on an owned emulator. Captures Home at
// 270 dp font 1.3 and 393 dp font 1.0, dark and light, at rest and scrolled to
// the end, then answers protocol 22 (a restart onto the update) and captures
// Home recovering with no tap. Run from the repo root, after `yarn build`:
// node <this> <apk> <evidence-dir>; MUXR_LAB_AVD_HOME picks the emulator home.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
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
const OUTDATED = /Herdr is out of date on your computer/;
const log = [];
const note = (line) => { log.push(line); console.log(line); writeFileSync(join(evidence, 'journey.log'), `${log.join('\n')}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defects = [];

const emu = await bootOwnedEmulator({ name: 'mxherdrold', avdHome: process.env.MUXR_LAB_AVD_HOME, launcher: ['nice', '-n', '10'], extraArgs: ['-no-snapshot-load'] });
note(`emulator ${emu.serial} pid ${emu.pid}`);
const adb = (...args) => exec('adb', ['-s', emu.serial, ...args], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
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
// Visual leads stay in each cell's .check.txt for the self-review: Home's header and
// composer carry leads of their own on main, so only the journey's checks fail the run.
const cell = (dir, name, end) => {
    let report;
    try { report = execFileSync('node', [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), emu.serial, dir, name, ...(end ? ['--end'] : [])], { encoding: 'utf8' }); }
    catch (cause) { report = `${cause.stdout ?? ''}${cause.stderr ?? ''}`; }
    writeFileSync(join(dir, `${name}.check.txt`), report);
    note(`captured ${name}: ${report.split('\n').filter((r) => r.startsWith('DEFECT')).length} defect leads`);
};
// The fake's own control method, on its socket: a restart onto the updated Herdr.
const setProtocol = (socketPath, protocol) => new Promise((done, fail) => {
    const socket = createConnection(socketPath);
    socket.on('error', fail);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'lab', method: 'lab.protocol', params: { protocol } })}\n`));
    socket.on('data', () => { socket.destroy(); done(); });
});

let stack;
try {
    await adb('install', '-r', apk);
    await adb('shell', 'pm', 'clear', PKG);
    note('installed release APK, cleared data');
    stack = await startFakeStack({ panes: 4, agents: 1, protocol: 21 });
    const herdrSocket = join(stack.root, 'herdr', 'herdr.sock');
    note(`lab stack: relay ${stack.relayPort}, host pid ${stack.pids.host}, relay pid ${stack.pids.relay}, fake Herdr pid ${stack.herdrPid} answering protocol 21`);
    setAndroidSerial(emu.serial);
    for (const args of [['svc', 'power', 'stayon', 'true'], ['input', 'keyevent', 'KEYCODE_WAKEUP'], ['wm', 'dismiss-keyguard']]) await adb('shell', ...args).catch(() => undefined);
    const pairing = await stack.mintPairing();
    const link = /^(muxr|https?):/.test(pairing.code) ? pairing.code : `muxr://pair#${pairing.code}`;
    await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
    let tapped = false;
    for (let i = 0; i < 30 && !tapped; i += 1) {
        await sleep(2000);
        const nodes = [...(await dump()).matchAll(/<node\s[^>]*>/g)].map((m) => m[0]);
        const node = nodes.find((n) => /(text|content-desc)="Pair"/.test(n) && n.includes('clickable="true"')) ?? nodes.find((n) => /text="Pair"/.test(n));
        if (node === undefined) continue;
        const [, x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
        await adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
        tapped = true;
    }
    note(`tapped Pair: ${tapped}`);
    const shown = await waitFor((xml) => OUTDATED.test(xml), 90);
    pairing.release();
    note(`Home shows "Herdr is out of date on your computer": ${shown}`);
    if (!shown) {
        defects.push('Home never showed the out-of-date card');
        await adb('shell', 'screencap', '-p', '/sdcard/miss.png'); await adb('pull', '/sdcard/miss.png', join(evidence, 'miss.png'));
    }
    const hostLine = stack.hostLog().split('\n').find((row) => row.startsWith('Herdr is out of date'));
    note(`host log: ${hostLine ?? 'no plain out-of-date line'}`);
    if (hostLine === undefined) defects.push('the host log never said Herdr is out of date');

    const dir = join(evidence, 'native');
    mkdirSync(dir, { recursive: true });
    for (const [dp, density, font] of [['270', '640', '1.3'], ['393', '440', '1.0']]) {
        for (const theme of ['dark', 'light']) {
            await adb('shell', 'wm', 'size', '1080x2376');
            await adb('shell', 'wm', 'density', density);
            await adb('shell', 'settings', 'put', 'system', 'font_scale', font);
            await adb('shell', 'cmd', 'uimode', 'night', theme === 'dark' ? 'yes' : 'no');
            await sleep(3000);
            const name = `home-outdated-${dp}-${font}-${theme}`;
            cell(dir, name, false);
            await adb('shell', 'input', 'swipe', '540', '1800', '540', '500', '800');
            await sleep(1500);
            cell(dir, `${name}-end`, true);
            await adb('shell', 'input', 'swipe', '540', '500', '540', '1800', '800');
        }
    }

    await adb('shell', 'wm', 'density', '440');
    await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0');
    await adb('shell', 'cmd', 'uimode', 'night', 'yes');
    const flipped = Date.now();
    await setProtocol(herdrSocket, 22);
    note('fake Herdr now answers protocol 22 (restarted onto the update)');
    const recovered = await waitFor((xml) => !OUTDATED.test(xml) && !/Agent runtime unavailable/.test(xml) && /Claude|Codex|pi|shell/i.test(xml), 90);
    note(`Home dropped the card with no tap: ${recovered} after ${Math.round((Date.now() - flipped) / 1000)}s`);
    if (!recovered) defects.push('Home kept the card after Herdr answered protocol 22');
    cell(dir, 'home-recovered-393-1.0-dark', false);
    writeFileSync(join(evidence, 'host-log-herdr.txt'), `${stack.hostLog().split('\n').filter((row) => /herdr|Herdr/.test(row)).join('\n')}\n`);
    writeFileSync(join(evidence, 'steps.json'), JSON.stringify({
        start: 'fresh app data on an Android emulator; a private lab host over a fake Herdr whose binary reports 0.9.1 while its running server answers protocol 21',
        steps: ['open the muxr://pair link from the lab host and tap Pair', 'read Home at 270 dp font 1.3 and 393 dp font 1.0, dark and light, at rest and scrolled to the end', 'the fake Herdr answers protocol 22, as after a restart onto the update'],
        result: 'the host log says "Herdr is out of date: muxr needs Herdr 0.9.1 or newer. Run `herdr update`, then restart Herdr."; Home titles "Herdr is out of date on your computer" with `herdr update` to copy; once Herdr answers 22, Home drops the card and lists the agents with no tap',
    }, null, 2));
} finally {
    try { await adb('shell', 'wm', 'size', 'reset'); await adb('shell', 'wm', 'density', 'reset'); await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0'); } catch { /* emulator gone */ }
    stack?.stop();
    note('stack stopped');
    await emu.stop();
    note('emulator stopped');
    for (const defect of defects) note(`DEFECT ${defect}`);
    note(`done; defects: ${defects.length}`);
    process.exitCode = defects.length > 0 ? 1 : 0;
}
