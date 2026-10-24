// Home's version line and Settings > About (home-version-line.md): the release
// APK on an owned emulator, paired to a real host and relay over the fake
// Herdr. First the host runs this checkout's version (the line reads
// `App X · Host X`), then a lab-only manifest makes it announce 0.2.10 (the
// line adds the plain mismatch hint). Captures the foot of Home and the
// Settings Version row at 270 dp font 2.0 and 393 dp font 1.0, dark and light,
// and taps the line to prove it opens Settings > Connection. Run from the repo
// root, after `yarn build`: node <this> <apk> <evidence-dir>;
// MUXR_LAB_AVD_HOME picks the emulator home.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const OLD_HOST = '0.2.10';
// Build output, never tracked: the host walks up to the first manifest it finds.
const hostManifest = join(repo, 'apps/host/dist/package.json');
const log = [];
const note = (line) => { log.push(line); console.log(line); writeFileSync(join(evidence, 'journey.log'), `${log.join('\n')}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defects = [];

const emu = await bootOwnedEmulator({ name: 'mxversions', avdHome: process.env.MUXR_LAB_AVD_HOME, launcher: ['nice', '-n', '10'], extraArgs: ['-no-snapshot-load'] });
note(`emulator ${emu.serial} pid ${emu.pid}`);
// Before any stack starts: its adb reverse must name this emulator, never another attached device.
setAndroidSerial(emu.serial);
const adbOnce = (...args) => exec('adb', ['-s', emu.serial, ...args], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
// A loaded emulator drops an occasional shell call (exit 255); one retry rides it out.
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
        if (at !== undefined) {
            await adb('shell', 'input', 'tap', String(at.x), String(at.y));
            return true;
        }
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
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Swipes start above the composer dock: a swipe that starts on it never reaches the list.
const swipeUp = async () => { await adb('shell', 'input', 'swipe', '540', '1400', '540', '400', '500'); await sleep(1200); };
// Until two dumps in a row match: the list stopped moving, so this is its end.
const toEnd = async () => {
    let last = '';
    for (let i = 0; i < 12; i += 1) {
        await swipeUp();
        const xml = await dump();
        if (xml === last) return;
        last = xml;
    }
};
// Steps the list until the node the pattern names sits whole between the header
// and the navigation bar (a 1080x2376 frame), for a row above a list's end.
const scrollIntoView = async (pattern) => {
    for (let i = 0; i < 24; i += 1) {
        const node = [...(await dump()).matchAll(/<node\s[^>]*>/g)].map((m) => m[0]).find((n) => pattern.test(n));
        if (node === undefined) { await adb('shell', 'input', 'swipe', '540', '1400', '540', '700', '700'); await sleep(1200); continue; }
        const [, , y1, , y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
        if (y1 >= 330 && y2 <= 2180) return true;
        // Too low: lift it by what it overhangs; too high: bring it back down.
        const lift = y2 > 2180 ? Math.min(900, Math.max(250, y2 - 1900)) : -Math.min(900, Math.max(250, 600 - y1));
        await adb('shell', 'input', 'swipe', '540', String(1500), '540', String(1500 - lift), '900');
        await sleep(1200);
    }
    return false;
};
const toTop = async () => { for (let i = 0; i < 4; i += 1) { await adb('shell', 'input', 'swipe', '540', '300', '540', '1500', '600'); await sleep(700); } };
const relaunch = async () => {
    await adb('shell', 'am', 'force-stop', PKG);
    await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    await sleep(6000);
};
const CELLS = [['270', '640', '2.0'], ['393', '440', '1.0']];

let stack;
let finished = false;
const pairFresh = async () => {
    await adb('shell', 'pm', 'clear', PKG);
    stack = await startFakeStack({ panes: 2, agents: 1 });
    note(`lab stack: relay ${stack.relayPort}, host pid ${stack.pids.host}, relay pid ${stack.pids.relay}`);
    for (const args of [['svc', 'power', 'stayon', 'true'], ['input', 'keyevent', 'KEYCODE_WAKEUP'], ['wm', 'dismiss-keyguard']]) await adb('shell', ...args).catch(() => undefined);
    const pairing = await stack.mintPairing();
    const link = /^(muxr|https?):/.test(pairing.code) ? pairing.code : `muxr://pair#${pairing.code}`;
    await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
    const tapped = await tap(/(text|content-desc)="Pair"[^>]*clickable="true"|clickable="true"[^>]*(text|content-desc)="Pair"|text="Pair"/, 60);
    note(`tapped Pair: ${tapped}`);
    const home = await waitFor((xml) => /App \d+\.\d+\.\d+/.test(xml), 90);
    pairing.release();
    return home;
};

// One state: the foot of Home and the Settings Version row in every cell.
const captureState = async (state, expected) => {
    const dir = join(evidence, 'native', state);
    mkdirSync(dir, { recursive: true });
    const pattern = new RegExp(escape(expected));
    for (const [dp, density, font] of CELLS) {
        for (const theme of ['dark', 'light']) {
            await adb('shell', 'wm', 'size', '1080x2376');
            await adb('shell', 'wm', 'density', density);
            await adb('shell', 'settings', 'put', 'system', 'font_scale', font);
            await adb('shell', 'cmd', 'uimode', 'night', theme === 'dark' ? 'yes' : 'no');
            await relaunch();
            await toEnd();
            const shown = await waitFor((xml) => pattern.test(xml), 30);
            if (!shown) defects.push(`${state} ${dp}/${font}/${theme}: Home foot never read "${expected}"`);
            cell(dir, `home-foot-${state}-${dp}-${font}-${theme}`, true);
            await toTop();
            if (!await tap(/content-desc="Settings"/)) { defects.push(`${state}: no Settings button on Home`); continue; }
            await sleep(2500);
            const row = await scrollIntoView(new RegExp(`text="${escape(expected)}`)) && /text="Version"/.test(await dump());
            if (!row) defects.push(`${state} ${dp}/${font}/${theme}: Settings Version row never read "${expected}"`);
            cell(dir, `settings-version-${state}-${dp}-${font}-${theme}`, false);
        }
    }
};

try {
    // A rebuilt APK carries a fresh test signature; only this lab's own app on this lab's emulator is removed for it.
    await adb('install', '-r', apk).catch(async (cause) => {
        if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(cause.stderr))) throw cause;
        await adb('uninstall', PKG);
        await adb('install', apk);
    });
    note('installed release APK');

    rmSync(hostManifest, { force: true });
    if (!await pairFresh()) defects.push('Home never showed the version line after pairing');
    const same = `App ${version} · Host ${version}`;
    note(`stable state: expecting "${same}"`);
    await captureState('same', same);
    stack.stop();
    stack = undefined;

    // A lab-only manifest: the host now announces an older release than the app.
    writeFileSync(hostManifest, `${JSON.stringify({ version: OLD_HOST, type: 'module' })}\n`);
    if (!await pairFresh()) defects.push('Home never showed the version line against the older host');
    const differ = `App ${version} · Host ${OLD_HOST} · App and computer versions differ · Review updates`;
    note(`mismatch state: expecting "${differ}"`);
    await captureState('mismatch', `App ${version} · Host ${OLD_HOST}`);
    await adb('shell', 'wm', 'density', '440');
    await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0');
    await relaunch();
    await toEnd();
    if (!await waitFor((xml) => new RegExp(escape(differ)).test(xml), 30)) defects.push(`Home foot never read "${differ}"`);
    if (!await tap(new RegExp(`text="${escape(differ)}"`))) defects.push('the version line was not tappable');
    const opened = await waitFor((xml) => /Connection &amp; updates|Connection & updates/.test(xml), 20);
    note(`tapping the line opened Settings > Connection: ${opened}`);
    if (!opened) defects.push('tapping the version line did not open the versions screen');
    cell(join(evidence, 'native', 'mismatch'), 'connection-after-tap-393-1.0-light', false);

    const steps = JSON.stringify({
        target: { version },
        start: 'fresh app data on an Android emulator; a private lab host over a fake Herdr, first on this checkout\'s version, then announcing 0.2.10',
        steps: ['open the muxr://pair link from the lab host and tap Pair', 'read the foot of Home and Settings > About > Version at 270 dp font 2.0 and 393 dp font 1.0, dark and light', 'restart the host announcing 0.2.10, pair fresh, read the same screens', 'tap the version line on Home'],
        result: `Home's foot and the Settings Version row read "${same}" against a matching host and "${differ}" against the older one; the line opens Settings > Connection`,
    }, null, 2);
    for (const at of [evidence, join(evidence, 'native')]) writeFileSync(join(at, 'steps.json'), steps);
    finished = true;
} finally {
    if (!finished) defects.push('the journey stopped before its end');
    rmSync(hostManifest, { force: true });
    try { await adb('shell', 'wm', 'size', 'reset'); await adb('shell', 'wm', 'density', 'reset'); await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0'); } catch { /* emulator gone */ }
    stack?.stop();
    note('stack stopped');
    await emu.stop();
    note('emulator stopped');
    for (const defect of defects) note(`DEFECT ${defect}`);
    note(`done; defects: ${defects.length}`);
    process.exitCode = defects.length > 0 ? 1 : 0;
}
