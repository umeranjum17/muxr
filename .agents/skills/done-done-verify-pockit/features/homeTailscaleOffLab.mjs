// Home when the phone is online but its Tailscale path to the computer is gone
// (home-tailscale-off.md): a real host and relay over the fake Herdr, the
// pairing offer naming this desktop's Tailscale address (read-only
// `tailscale ip -4`), which this lab forwards to the loopback relay. The
// release APK on an owned emulator, which holds no Tailscale address of its
// own, pairs, then the forwarder closes while the relay and host keep running:
// Home must say "Tailscale is off on this phone" with Open Tailscale, never
// "This device has no network". Airplane mode then cuts the internet too, and
// only then may Home say "You're offline". Run from the repo root, after
// `yarn build`: node <this> <apk> <evidence-dir>; MUXR_LAB_AVD_HOME picks the
// emulator home.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
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
const TAILSCALE_OFF = /Tailscale is off on this phone/;
const NO_NETWORK = /This device has no network/;
const log = [];
const note = (line) => { log.push(line); console.log(line); writeFileSync(join(evidence, 'journey.log'), `${log.join('\n')}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defects = [];

const tailnetIp = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
if (!/^100\.\d+\.\d+\.\d+$/.test(tailnetIp)) throw new Error(`this desktop has no Tailscale IPv4 address (${tailnetIp})`);

const emu = await bootOwnedEmulator({ name: 'mxtsoff', avdHome: process.env.MUXR_LAB_AVD_HOME, launcher: ['nice', '-n', '10'], extraArgs: ['-no-snapshot-load'] });
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
        const xml = await dump();
        if (test(xml)) return xml;
        await sleep(2000);
    }
    return undefined;
};
const tap = async (xml, label) => {
    const node = [...xml.matchAll(/<node\s[^>]*>/g)].map((m) => m[0]).find((n) => new RegExp(`(text|content-desc)="${label}"`).test(n));
    if (node === undefined) return false;
    const [, x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
    await adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
    return true;
};
const cell = (dir, name) => {
    let report;
    try { report = execFileSync('node', [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), emu.serial, dir, name], { encoding: 'utf8' }); }
    catch (cause) { report = `${cause.stdout ?? ''}${cause.stderr ?? ''}`; }
    writeFileSync(join(dir, `${name}.check.txt`), report);
    note(`captured ${name}: ${report.split('\n').filter((r) => r.startsWith('DEFECT')).length} defect leads`);
};
// A density or theme change recreates the activity, which redials and probes
// again before its card returns: each shot waits for its own words first.
const settle = async (name, expect) => {
    if (await waitFor(expect, 150) === undefined) defects.push(`the card did not come back at ${name}`);
};
const view = async (dp, density, font, theme) => {
    await adb('shell', 'wm', 'size', '1080x2376');
    await adb('shell', 'wm', 'density', density);
    await adb('shell', 'settings', 'put', 'system', 'font_scale', font);
    await adb('shell', 'cmd', 'uimode', 'night', theme === 'dark' ? 'yes' : 'no');
    await sleep(3000);
    return `${dp}-${font}-${theme}`;
};

let stack;
let forwarder;
let finished = false;
try {
    await adb('install', '-r', apk).catch(async (cause) => {
        if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(cause.stderr))) throw cause;
        await adb('uninstall', PKG);
        await adb('install', apk);
    });
    await adb('shell', 'pm', 'clear', PKG);
    note('installed release APK, cleared data');
    // The emulator's disk keeps airplane mode from an earlier run that stopped before its cleanup.
    for (const args of [['cmd', 'connectivity', 'airplane-mode', 'disable'], ['settings', 'put', 'global', 'heads_up_notifications_enabled', '0'], ['svc', 'power', 'stayon', 'true'], ['input', 'keyevent', 'KEYCODE_WAKEUP'], ['wm', 'dismiss-keyguard']]) await adb('shell', ...args).catch(() => undefined);
    // The emulator reaches this desktop's Tailscale address through the host's
    // network stack, without one of its own: the phone with Tailscale off whose
    // path to the computer still worked a moment ago.
    stack = await startFakeStack({ panes: 4, agents: 1, transport: 'loopback', advertiseHost: tailnetIp });
    const sockets = new Set();
    forwarder = createServer((inbound) => {
        const outbound = connect(stack.relayPort, '127.0.0.1');
        for (const s of [inbound, outbound]) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => undefined); }
        inbound.pipe(outbound).pipe(inbound);
    });
    await new Promise((done, fail) => { forwarder.once('error', fail); forwarder.listen(stack.relayPort, tailnetIp, done); });
    note(`lab stack: relay 127.0.0.1:${stack.relayPort} forwarded from the Tailscale address, host pid ${stack.pids.host}, relay pid ${stack.pids.relay}`);
    setAndroidSerial(emu.serial);
    const pairing = await stack.mintPairing();
    const link = /^(muxr|https?):/.test(pairing.code) ? pairing.code : `muxr://pair#${pairing.code}`;
    await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
    const pairScreen = await waitFor((xml) => /(text|content-desc)="Pair"/.test(xml), 60);
    note(`tapped Pair: ${pairScreen !== undefined && await tap(pairScreen, 'Pair')}`);
    // An agent card carries its state in content-desc ("… Idle. …").
    const home = await waitFor((xml) => /content-desc="[^"]*\. (Idle|Working)\. /.test(xml), 90);
    pairing.release();
    note(`Home connected over the Tailscale address: ${home !== undefined}`);
    if (home === undefined) defects.push('the phone never reached Home over the Tailscale address');

    // The Tailscale path goes away; the relay and the host keep running.
    await new Promise((done) => { forwarder.close(() => done()); for (const s of sockets) s.destroy(); });
    forwarder = undefined;
    note('Tailscale path closed; relay and host still running');
    const shown = await waitFor((xml) => TAILSCALE_OFF.test(xml) && /Open Tailscale/.test(xml), 150);
    note(`Home says "Tailscale is off on this phone" with Open Tailscale: ${shown !== undefined}`);
    if (shown === undefined) defects.push('Home never said Tailscale is off');
    if (shown !== undefined && NO_NETWORK.test(shown)) defects.push('Home blamed the device network while it was online');
    const dir = join(evidence, 'native');
    mkdirSync(dir, { recursive: true });
    for (const [dp, density, font] of [['390', '443', '1.0'], ['270', '640', '1.3']]) {
        for (const theme of ['light', 'dark']) {
            const name = `home-tailscale-off-${await view(dp, density, font, theme)}`;
            await settle(name, (xml) => TAILSCALE_OFF.test(xml) && /Open Tailscale/.test(xml));
            cell(dir, name);
        }
    }
    await view('390', '443', '1.0', 'dark');
    const card = await dump();
    const opened = await tap(card, 'Open Tailscale');
    await sleep(4000);
    const { stdout: top } = await adb('shell', 'dumpsys', 'activity', 'activities');
    const resumed = (top.match(/(?:topResumedActivity|mResumedActivity)[^\n]*/) ?? ['none'])[0].trim();
    note(`tapped Open Tailscale: ${opened}; resumed after: ${resumed}`);
    if (!opened || resumed.includes(PKG)) defects.push('Open Tailscale did not leave muxr for Tailscale or its store page');
    // A cold start skips the busy grace and lands on the recovery card, the
    // card with Retry the owner saw.
    await adb('shell', 'am', 'force-stop', PKG);
    await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    const recovery = await waitFor((xml) => TAILSCALE_OFF.test(xml) && /Retry connection/.test(xml), 150);
    note(`cold start: recovery card says "Tailscale is off on this phone" with Retry connection: ${recovery !== undefined}`);
    if (recovery === undefined) defects.push('the recovery card never said Tailscale is off');
    if (recovery !== undefined && NO_NETWORK.test(recovery)) defects.push('the recovery card blamed the device network while it was online');
    for (const [dp, density, font, theme] of [['390', '443', '1.0', 'light'], ['390', '443', '1.0', 'dark'], ['270', '640', '1.3', 'dark']]) {
        const name = `home-recovery-tailscale-off-${await view(dp, density, font, theme)}`;
        await settle(name, (xml) => TAILSCALE_OFF.test(xml) && /Retry connection/.test(xml));
        cell(dir, name);
    }

    // Now the internet goes too: only now may Home blame this device's network.
    await adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable');
    const offline = await waitFor((xml) => /You're offline/.test(xml) && NO_NETWORK.test(xml), 90);
    note(`airplane mode: Home says "You're offline" / "This device has no network": ${offline !== undefined}`);
    if (offline === undefined) defects.push('Home never said the device is offline with airplane mode on');
    const offlineName = `home-offline-${await view('390', '443', '1.0', 'dark')}`;
    await settle(offlineName, (xml) => /You're offline/.test(xml) && NO_NETWORK.test(xml));
    cell(dir, offlineName);
    await adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');

    const steps = JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: "fresh app data on an Android emulator with internet and no Tailscale address; a private lab host whose pairing offer names this desktop's Tailscale address, forwarded to the lab relay",
        steps: ['open the muxr://pair link and tap Pair; Home connects', 'close the Tailscale path while the relay and host keep running', 'read Home at 390 dp font 1.0 and 270 dp font 1.3, light and dark', 'tap Open Tailscale', 'cold-start the app and read the recovery card at 390 dp light and dark and 270 dp font 1.3 dark', 'turn airplane mode on and read Home at 390 dp dark'],
        result: 'with the internet up and the Tailscale path gone, Home says "Tailscale is off on this phone" with Open Tailscale (the busy card, then after a cold start the recovery card with Retry connection), never "This device has no network"; Open Tailscale leaves muxr; only with airplane mode on does Home say "You\'re offline" and "This device has no network"',
    }, null, 2);
    for (const at of [evidence, dir]) writeFileSync(join(at, 'steps.json'), steps);
    finished = true;
} finally {
    if (!finished) defects.push('the journey stopped before its end');
    try {
        await adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');
        await adb('shell', 'wm', 'size', 'reset'); await adb('shell', 'wm', 'density', 'reset'); await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0');
    } catch { /* emulator gone */ }
    forwarder?.close();
    stack?.stop();
    note('stack stopped');
    await emu.stop();
    note('emulator stopped');
    for (const defect of defects) note(`DEFECT ${defect}`);
    note(`done; defects: ${defects.length}`);
    process.exitCode = defects.length > 0 ? 1 : 0;
}
