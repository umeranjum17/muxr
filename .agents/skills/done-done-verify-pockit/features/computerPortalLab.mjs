// Computer against a screen-sharing portal that runs without ScreenCast (see
// computer-failure.md "Portal without ScreenCast"). Starts a private session bus
// and the real xdg-desktop-portal on it without a desktop name, points the perf
// fake stack's real host and engine at that bus, boots a task-owned emulator,
// pairs a release APK, and per cell (width, font, theme) opens Computer from an
// agent and captures the refusal. Then it restarts only its own portal with the
// desktop name and taps Try again, which must no longer say to restart. Run from
// the repo root, under the emulator lock:
//   node .agents/skills/done-done-verify-pockit/features/computerPortalLab.mjs --apk <apk> --evidence <dir> \
//     --avd-home <dir> [--expect "<overlay title>"]
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dismissPrompts, dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';
import { startFakeStack } from '../../../../perf/lib/fakeStack.mjs';
import { pairPhone } from '../../../../perf/lib/pairPhone.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' },
    expect: { type: 'string', default: 'Screen sharing needs a restart' },
} });
if (!opts.apk || !opts.evidence || !opts['avd-home']) throw new Error('--apk, --evidence and --avd-home are required');
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(opts.evidence);
const CHECK = resolve('.agents/skills/done-done-verify-pockit/features/visualCheck.mjs');
// 1080 px at density 443 is a 390 dp phone; 640 is the reference phone's 270 dp.
const CELLS = [[390, '1.0', 'light'], [390, '1.0', 'dark'], [270, '1.3', 'dark'], [270, '1.3', 'light']];
const DENSITY = { 390: 443, 270: 640 };
mkdirSync(EVIDENCE, { recursive: true });
const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => { const out = `${new Date().toISOString()} ${line}`; console.log(out); appendFileSync(join(EVIDENCE, 'journey.log'), `${out}\n`); };
let serial = '';
const adb = async (args, timeout = 60_000) => (await exec('adb', ['-s', serial, ...args], { timeout, maxBuffer: 64 << 20 })).stdout;
const sh = (cmd) => adb(['shell', cmd]);
const screenshot = async (path) => writeFileSync(path, (await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 30_000 })).stdout);

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
function nodes(xml) {
    return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
        const get = (key) => unescape(tag.match(new RegExp(` ${key}="([^"]*)"`))?.[1] ?? '');
        const box = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)?.slice(1).map(Number) ?? [0, 0, 0, 0];
        return { text: get('text'), desc: get('content-desc'), box };
    });
}
async function screen() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const xml = await dumpUiXml(30_000);
        if (xml !== '') {
            const found = nodes(xml);
            // A slow emulator raises "System UI isn't responding" over everything; wait it out.
            const wait = found.find((n) => n.text === 'Wait');
            if (found.some((n) => n.text.endsWith("isn't responding")) && wait) {
                await sh(`input tap ${center(wait).join(' ')}`);
                await sleep(2000);
                continue;
            }
            return found;
        }
        await sleep(1500);
    }
    return [];
}
const find = (found, test) => found.find((n) => test(n.text) || test(n.desc));
const is = (label) => (value) => value.toLowerCase() === label.toLowerCase();
const has = (label) => (found) => find(found, is(label)) !== undefined;
const center = ({ box: [l, t, r, b] }) => [Math.round((l + r) / 2), Math.round((t + b) / 2)];
async function waitFor(what, test, seconds = 60) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const found = await screen();
        if (test(found)) return found;
        await sleep(1500);
    }
    const stem = join(EVIDENCE, `missing-${what.replace(/\W+/g, '-')}`);
    await screenshot(`${stem}.png`).catch((error) => say(`screenshot failed: ${error.message}`));
    writeFileSync(`${stem}.txt`, (await screen()).filter((n) => n.text || n.desc).map((n) => `${n.text} | ${n.desc} | ${n.box}`).join('\n'));
    throw new Error(`${what} never appeared within ${seconds}s`);
}
async function tapOn(what, test, seconds = 60) {
    // Tap only once the target holds still across two reads: screens re-lay out as data loads.
    let node = find(await waitFor(what, (found) => find(found, test) !== undefined, seconds), test);
    for (let i = 0; i < 10; i += 1) {
        await sleep(1000);
        const again = find(await screen(), test);
        if (again !== undefined && String(again.box) === String(node.box)) break;
        node = again ?? node;
    }
    say(`tap ${what}`);
    await sh(`input tap ${center(node).join(' ')}`);
}
const atHome = (found) => has('connected')(found) && has('Plan, ask, build…')(found);
async function back() { await sh('input keyevent KEYCODE_BACK'); await sleep(1200); }
async function toHome() {
    for (let i = 0; i < 5; i += 1) {
        if (atHome(await screen())) return;
        await back();
    }
    await waitFor('connected Home', atHome, 30);
}

const defects = [];
async function capture(dir, name) {
    await sleep(1500);
    const run = await exec(process.execPath, [CHECK, serial, dir, name], { timeout: 180_000, maxBuffer: 16 << 20 }).then((r) => ({ out: r.stdout }), (e) => ({ out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    const lines = run.out.split('\n').filter((line) => line.startsWith('DEFECT'));
    for (const line of lines) defects.push(`${name}: ${line}`);
    say(`shot ${name}: ${lines.length === 0 ? 'clean' : lines.join(' | ')}`);
}

async function openOffer(_flow, { PAIR_CODE }) {
    try {
        await sh(`am start -a android.intent.action.VIEW -d 'muxr://pair#${PAIR_CODE}' ${PKG}`);
        await tapOn('Pair', is('Pair'), 60);
        await waitFor('connected after Pair', has('connected'), 120);
        return { code: 0, output: 'paired through the consent card' };
    } catch (error) {
        return { code: 1, output: String(error?.message ?? error) };
    }
}

// The lab's own bus and portal. The bus activates nothing the owner installed
// (one empty service dir), and its socket stays under the 107-byte limit.
const portalRoot = mkdtempSync(join(homedir(), '.cache', 'fms', 'cp-'));
const bus = join(portalRoot, 'bus');
mkdirSync(join(portalRoot, 'services'));
mkdirSync(join(portalRoot, 'run'), { mode: 0o700 });
writeFileSync(join(portalRoot, 'bus.conf'), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${bus}</listen><servicedir>${join(portalRoot, 'services')}</servicedir>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
`);
const children = [];
function own(command, args, env) {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
    children.push(child);
    return child;
}
async function startPortal(desktop) {
    const env = { HOME: portalRoot, PATH: '/usr/bin', XDG_RUNTIME_DIR: join(portalRoot, 'run'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`, ...desktop };
    const portal = own('/usr/lib/xdg-desktop-portal', [], env);
    for (let i = 0; i < 40; i += 1) {
        const listed = await exec('busctl', [`--address=unix:path=${bus}`, 'introspect', 'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop']).then((r) => r.stdout, () => '');
        if (listed.includes('org.freedesktop.portal.Settings')) return { portal, screenCast: listed.includes('org.freedesktop.portal.ScreenCast ') };
        await sleep(250);
    }
    throw new Error('the lab portal never came up');
}

let emulator;
let stack;
try {
    own('dbus-daemon', ['--nofork', `--config-file=${join(portalRoot, 'bus.conf')}`], process.env);
    await sleep(500);
    let { portal, screenCast } = await startPortal({});
    say(`lab portal without a desktop name: ScreenCast ${screenCast ? 'offered' : 'absent'}`);
    if (screenCast) throw new Error('the lab portal offers ScreenCast; this journey needs it absent');
    // The host and its engine meet only the lab bus, and a Wayland name that
    // exists nowhere, so they pick the portal and never reach the owner's desktop.
    for (const key of ['DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'MUXR_DESKTOP_SOURCE']) delete process.env[key];
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
    process.env.WAYLAND_DISPLAY = 'wayland-lab';

    emulator = await bootOwnedEmulator({ name: 'mxcp', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no');
    stack = await startFakeStack({ panes: 2, agents: 2, titleChurnHz: 0 });
    say(`fake stack relay port ${stack.relayPort}`);
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => undefined);
    const paired = await pairPhone({ stack, maestro: openOffer });
    if (!paired.ok) throw new Error(`pairing failed: ${paired.why}`);
    await dismissPrompts(['CANCEL', 'Not now', 'Deny', 'Later']);

    const openComputer = async () => {
        await tapOn('Home card', (v) => /\. (Idle|Working|Done|Needs you)\b/.test(v));
        await tapOn('Pane actions', is('Pane actions'), 60);
        await tapOn('Computer', is('Computer'), 20);
        await waitFor(opts.expect, has(opts.expect), 60);
    };
    for (const [width, font, theme] of CELLS) {
        const cell = `${width}-${font}-${theme}`;
        const dir = join(EVIDENCE, cell);
        mkdirSync(dir, { recursive: true });
        await sh(`wm size 1080x2376; wm density ${DENSITY[width]}; settings put system font_scale ${font}; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        await sh(`am force-stop ${PKG}`);
        await sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        await waitFor('the app', (found) => has('connected')(found) || has('Back')(found), 120);
        await toHome();
        await sleep(2000);
        await openComputer();
        await capture(dir, `computer-${cell}`);
        await toHome();
    }

    // The cure the copy names, on the lab's own portal only: restarted with the
    // desktop name, Try again no longer reads as a restart.
    await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no');
    await sh(`am force-stop ${PKG}`);
    await sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
    await waitFor('the app', (found) => has('connected')(found) || has('Back')(found), 120);
    await toHome();
    await openComputer();
    portal.kill();
    await new Promise((done) => portal.once('exit', done));
    ({ portal, screenCast } = await startPortal({ XDG_CURRENT_DESKTOP: 'Hyprland' }));
    say(`lab portal restarted with the desktop name: ScreenCast ${screenCast ? 'offered' : 'absent'}`);
    await tapOn('Try again', is('Try again'), 20);
    await waitFor('a different answer after the restart', (found) => !has(opts.expect)(found) && (has("Couldn't open this computer")(found) || has('Waiting for screen sharing')(found)), 60);
    await screenshot(join(EVIDENCE, 'after-portal-restart.png'));
    say('after the portal restart Try again no longer says to restart');
    writeFileSync(join(EVIDENCE, 'host-desktop.log'), `${stack.hostLog().split('\n').filter((line) => /desktop (engine|open)|desktop\.open/.test(line)).map((line) => line.replace(/dev_[A-Za-z0-9_-]+/, 'dev_<lab>')).join('\n')}\n`);
    say(`defects: ${defects.length === 0 ? 'none' : `\n${defects.join('\n')}`}`);
    say('RESULT done');
} catch (error) {
    say(`RESULT FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (serial) await screenshot(join(EVIDENCE, 'failure.png')).catch(() => undefined);
    process.exitCode = 1;
} finally {
    if (serial) await sh('wm size reset; wm density reset; settings put system font_scale 1.0').catch(() => undefined);
    stack?.stop();
    await emulator?.stop();
    for (const child of children.reverse()) child.kill();
    await sleep(500);
    rmSync(portalRoot, { recursive: true, force: true });
    say('stack, emulator and lab portal stopped');
}
