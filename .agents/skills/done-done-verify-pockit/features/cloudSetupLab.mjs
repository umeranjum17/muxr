// A new Boat cloud computer set up from the phone over SSH, with no tailnet (cloud-computer-onboarding, ssh-route).
// Boots a task-owned emulator at 390 dp, runs boatSignInLab.mjs with its stand-in computer (BOAT_LAB_SSH: a real sshd
// and this checkout's muxr in a namespace of their own), links the lab Boat account on a release APK built with
// EXPO_PUBLIC_MUXR_BOAT_API, taps Create cloud computer and then nothing in muxr: no browser may open, each set-up
// step is captured, and the phone must land on Home with the computer connected through the SSH tunnel.
// Needs a provisioned Herdr lab (HERDR_LAB_HELPER, HERDR_LAB_SESSION). With --upstream and --key-file it is the real run
// instead (it costs money: only once approved): the lab is the key proxy in front of that Boat API, so the phone creates
// a real machine with the lab's key only, and the journey removes every machine the run created and reads the account
// back. --screen then goes on to the screen for sign-ins: a shell, Computer, the no-screen card's Set it up for me, the
// installed desktop, Firefox from its dock and a sign-in page with a field tapped and typed into (no sign-in is sent).
// --hold <s> keeps the machine and the emulator after a failure until <evidence>/release exists or the hold ends (never
// past 50 minutes after Create), so `--attach <serial>` can run the screen part again on the same phone. Run from the repo root:
//   node .agents/skills/done-done-verify-pockit/features/cloudSetupLab.mjs --apk <apk> --evidence <dir> --avd-home <dir> --port <boat lab port>
//     (--machine <short dir> | --upstream <api base> --key-file <path>) [--dp 390|270] [--font 1.0|2.0] [--theme light|dark] [--screen [--hold <s>]]
//   node .agents/skills/done-done-verify-pockit/features/cloudSetupLab.mjs --attach <serial> --evidence <dir>
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { boat } from '@byokit/cloud';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dismissPrompts, dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' }, port: { type: 'string' }, machine: { type: 'string' },
    dp: { type: 'string', default: '390' }, font: { type: 'string', default: '1.0' }, theme: { type: 'string', default: 'light' },
    upstream: { type: 'string' }, 'key-file': { type: 'string' },
    screen: { type: 'boolean', default: false }, hold: { type: 'string', default: '0' }, attach: { type: 'string' },
} });
if (!opts.evidence || (!opts.attach && (!opts.apk || !opts['avd-home'] || !opts.port))) throw new Error('--apk, --evidence, --avd-home and --port are required (or --attach and --evidence)');
if (!opts.attach && (opts.upstream ? !opts['key-file'] || opts.machine : !opts.machine)) throw new Error('give --machine, or --upstream with --key-file');
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(opts.evidence);
mkdirSync(EVIDENCE, { recursive: true });
const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => { const out = `${new Date().toISOString()} ${line}`; console.log(out); appendFileSync(join(EVIDENCE, 'journey.log'), `${out}\n`); };
let serial = '';
const adb = async (args, timeout = 60_000) => (await exec('adb', ['-s', serial, ...args], { timeout, maxBuffer: 64 << 20 })).stdout;
const sh = (cmd) => adb(['shell', cmd]);
const shot = async (name) => {
    writeFileSync(join(EVIDENCE, `${name}.png`), (await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 30_000 })).stdout);
    say(`shot ${name}.png`);
};

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
async function screen() {
    const xml = await dumpUiXml(30_000).catch(() => '');
    return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
        const get = (key) => unescape(tag.match(new RegExp(` ${key}="([^"]*)"`))?.[1] ?? '');
        const box = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)?.slice(1).map(Number) ?? [0, 0, 0, 0];
        return { text: get('text'), desc: get('content-desc'), pkg: get('package'), box };
    });
}
const find = (found, test) => found.find((n) => test(n.text) || test(n.desc));
// A loaded host can make the emulator's own System UI stop answering; that dialog is Android's, not muxr's: wait it out.
async function answerAnr(found) {
    const wait = find(found, (v) => v === 'Wait');
    if (!wait || !find(found, (v) => /isn.t responding/.test(v))) return false;
    say('Android showed a not-responding dialog; tapping Wait');
    await sh(`input tap ${Math.round((wait.box[0] + wait.box[2]) / 2)} ${Math.round((wait.box[1] + wait.box[3]) / 2)}`);
    await sleep(1500);
    return true;
}
async function waitFor(what, test, seconds = 90) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const found = await screen();
        if (test(found)) return found;
        await answerAnr(found);
        await sleep(1500);
    }
    await shot(`missing-${what.replace(/\W+/g, '-')}`).catch(() => undefined);
    throw new Error(`${what} never appeared within ${seconds}s`);
}
async function tap(what, test, seconds = 90) {
    // On a short viewport the control can sit below the fold: scroll until it shows.
    for (let i = 0; i < 15; i += 1) {
        const found = await screen();
        if (find(found, test)?.box[3] < 2200) break;
        if (await answerAnr(found)) continue;
        await sh('input swipe 540 1700 540 900 300');
        await sleep(800);
    }
    const [l, t, r, b] = find(await waitFor(what, (found) => find(found, test) !== undefined, seconds), test).box;
    say(`tap ${what}`);
    await sh(`input tap ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)}`);
    await sleep(1500);
}
// Old files go first (the AVD's storage outlives a run); the stop file ends the loop before its last file is cut.
const RECORD = "rm -f /sdcard/mxrec-* /sdcard/mxrec.stop; i=0; while [ $i -lt 20 ] && [ ! -e /sdcard/mxrec.stop ]; do screenrecord --time-limit 170 --bit-rate 2000000 /sdcard/mxrec-$i.mp4 || break; i=$((i+1)); done";
async function stopRecording() {
    await sh('touch /sdcard/mxrec.stop').catch(() => undefined);
    await sh('pkill -INT screenrecord').catch(() => undefined);
    await sleep(3000);
    const files = (await sh('ls /sdcard/ | grep mxrec- || true')).split('\n').map((f) => f.trim()).filter(Boolean).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    for (const [i, file] of files.entries()) await adb(['pull', `/sdcard/${file}`, join(EVIDENCE, `recording-${String(i).padStart(2, '0')}.mp4`)], 120_000);
    say(`recording: ${files.length} file(s)`);
}
const focused = async () => (await sh('dumpsys window displays')).match(/mCurrentFocus=.*/)?.[0] ?? '';
let activity = '';
const bringMuxrBack = async () => { await sh(`am start -n ${activity}`); await sleep(2000); };

// Where a fresh xfce session draws on the host's 1920x1080 screen: its dock's web browser, Firefox's first window
// (its Welcome dialog's Continue, its address bar) and GitHub's sign-in field, as a stock Ubuntu 24.04 install shows them.
const DESKTOP = { width: 1920, height: 1080, browser: [983, 1055], welcomeContinue: [640, 353], addressBar: [650, 92], loginField: [640, 320] };
const SIGN_IN_PAGE = 'github.com/login';

/** Computer on a computer with no screen: Set it up for me, then a browser sign-in page tapped and typed into. */
async function screenPhase() {
    say('screen: open a shell, then Computer');
    await tap('Choose an agent', (v) => v === 'Choose an agent', 60);
    await tap('Shell', (v) => v.startsWith('Shell (no agent),'), 30);
    await tap('Start Shell', (v) => v.startsWith('Start Shell (no agent) in'), 30);
    await tap('Pane actions', (v) => v === 'Pane actions', 120);
    await tap('Computers', (v) => v === 'Computers', 30);
    // The stand-in computer shares this host's /tmp/.X11-unix, so its Computer would look at the owner's displays.
    if (opts.machine) {
        await waitFor('View screen', (found) => find(found, (v) => v === 'View screen') !== undefined, 30);
        await shot('08-computers');
        say('stand-in: stopping before View screen, which only a real cloud computer may open');
        return;
    }
    await tap('View screen', (v) => v === 'View screen', 30);
    const card = await waitFor('the Computer screen', (found) => find(found, (v) => v === 'Set it up for me' || v === 'Tap to control' || v === "Couldn't open this computer") !== undefined, 120);
    if (!find(card, (v) => v === 'Set it up for me')) { await shot('08-computer-without-card'); throw new Error(`Computer did not offer Set it up for me: ${card.filter((n) => n.text).map((n) => n.text).join(' | ')}`); }
    await sleep(1500);
    await shot('08-no-screen-card');
    await tap('Set it up for me', (v) => v === 'Set it up for me');
    await waitFor('Adding a screen', (found) => find(found, (v) => v === 'Adding a screen…') !== undefined, 30);
    await shot('09-adding-screen');
    const started = Date.now();
    const after = await waitFor('the desktop or a failure', (found) => find(found, (v) => v === 'Tap to control' || v === 'Set it up for me') !== undefined, 900);
    if (!find(after, (v) => v === 'Tap to control')) { await shot('10-screen-failed'); throw new Error(`the screen did not install: ${after.filter((n) => n.text).map((n) => n.text).join(' | ')}`); }
    say(`screen: installed and the desktop is live ${Math.round((Date.now() - started) / 1000)} s after Set it up for me`);
    await sleep(8000); // the session draws its panel and dock a moment after the picture starts
    await shot('10-desktop');
    await tap('Tap to control', (v) => v === 'Tap to control');
    // Touch maps through the picture, which the view letterboxes to the desktop's shape.
    const view = find(await screen(), (v) => v.endsWith(' desktop'));
    if (!view) throw new Error('the desktop view is missing');
    const [l, t, r, b] = view.box;
    const scale = Math.min((r - l) / DESKTOP.width, (b - t) / DESKTOP.height);
    const left = l + ((r - l) - DESKTOP.width * scale) / 2;
    const top = t + ((b - t) - DESKTOP.height * scale) / 2;
    const at = async (what, [x, y]) => {
        say(`desktop tap ${what}`);
        await sh(`input tap ${Math.round(left + x * scale)} ${Math.round(top + y * scale)}`);
    };
    const type = async (text) => {
        await tap('Keyboard', (v) => v === 'Keyboard');
        for (const chunk of text.match(/.{1,6}/g)) { await sh(`input text '${chunk}'`); await sleep(400); }
    };
    await at('the web browser in the dock', DESKTOP.browser);
    await sleep(30_000);
    await shot('11-firefox');
    await at('Continue on Firefox\'s welcome', DESKTOP.welcomeContinue);
    await sleep(5000);
    await at('the address bar', DESKTOP.addressBar);
    await type(SIGN_IN_PAGE);
    await sh('input keyevent KEYCODE_ENTER');
    await sleep(2000);
    await tap('Hide keyboard', (v) => v === 'Hide keyboard');
    await sleep(15_000);
    await shot('12-sign-in-page');
    await at('the username field', DESKTOP.loginField);
    await sleep(1500);
    await type('umer@example.com');
    await sleep(3000);
    await shot('13-typed-into-the-field');
    await tap('Hide keyboard', (v) => v === 'Hide keyboard');
    await sleep(2000);
    await shot('14-sign-in-page-filled');
    say('PASS: the screen for sign-ins showed a browser sign-in page that took a tap and typing (nothing was sent)');
}

if (opts.attach) {
    serial = opts.attach;
    activity = (await sh(`cmd package resolve-activity --brief ${PKG}`)).trim().split('\n').pop();
    await screenPhase();
    process.exit(0);
}

// The journey reaches Boat only through the lab, with the phone's own lab key, so it never holds the real one.
const account = boat({ baseUrl: `http://127.0.0.1:${opts.port}/api/v1`, label: 'Boat', prices: [], key: async () => 'boat-claimed-key' });
const machineIds = async () => new Set((await account.list()).map((ref) => ref.id));

let lab;
let emulator;
let recorder;
let before;
let created = 0;
try {
    const labEnv = opts.upstream ? { BOAT_LAB_UPSTREAM: opts.upstream, BOAT_LAB_KEY_FILE: resolve(opts['key-file']) } : { BOAT_LAB_SSH: resolve(opts.machine) };
    lab = spawn(process.execPath, ['.agents/skills/done-done-verify-pockit/features/boatSignInLab.mjs', opts.port], {
        env: { ...process.env, ...labEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let labOut = '';
    lab.stdout.on('data', (chunk) => { labOut += chunk; appendFileSync(join(EVIDENCE, 'boat-lab.log'), chunk); });
    lab.stderr.on('data', (chunk) => appendFileSync(join(EVIDENCE, 'boat-lab.log'), chunk));
    say(`boat lab pid ${lab.pid} on port ${opts.port}`);
    // The stand-in computer's sshd sits on this host's loopback; a real machine's SSH address is public.
    const ready = opts.upstream ? /boat lab listening/ : /BOAT_LAB_SSH_PORT=(\d+)/;
    while (!ready.test(labOut)) {
        if (lab.exitCode !== null) throw new Error(`the Boat lab stopped: ${labOut}`);
        await sleep(200);
    }
    const sshPort = labOut.match(/BOAT_LAB_SSH_PORT=(\d+)/)?.[1];
    if (sshPort) say(`stand-in computer's SSH on 127.0.0.1:${sshPort}`);

    emulator = await bootOwnedEmulator({ name: 'mxcs', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    // The phone's width in dp is 1080 px * 160 / density: 443 is 390 dp, 640 is 270 dp.
    const view = async (dp, font, theme) => {
        await sh(`wm density ${Math.round((1080 * 160) / Number(dp))}`);
        await sh(`settings put system font_scale ${font}`);
        await sh(`cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        say(`view: ${dp} dp, font ${font}, ${theme}`);
    };
    // The account link is the same at every view; a narrow view starts once the account is linked.
    await view(390, '1.0', 'light');
    await sh('settings put global heads_up_notifications_enabled 0').catch(() => undefined);
    await adb(['reverse', `tcp:${opts.port}`, `tcp:${opts.port}`]);
    if (sshPort) await adb(['reverse', `tcp:${sshPort}`, `tcp:${sshPort}`]);
    // Chrome's first-run screens would stand in front of every page it opens.
    await sh(`echo 'chrome --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line`);
    await sh('am set-debug-app --persistent com.android.chrome');
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => undefined);
    recorder = spawn('adb', ['-s', serial, 'shell', RECORD], { stdio: 'ignore' });
    activity = (await sh(`cmd package resolve-activity --brief ${PKG}`)).trim().split('\n').pop();
    await bringMuxrBack();
    await dismissPrompts().catch(() => undefined);

    // First run leads with Tailscale, the desktop app and pairing; the cloud entry sits below them.
    const cloudEntry = (v) => v === 'Cloud computer' || v === 'Add a cloud computer. Boat.';
    await waitFor('the first-run screen', (found) => find(found, (v) => v === 'Let’s connect' || cloudEntry(v)) !== undefined, 180);
    await tap('Cloud computer', cloudEntry);
    // A busy emulator drops keys from a long `input text`: type in short chunks and read the field back.
    const EMAIL = 'umer@example.com';
    for (let attempt = 0; ; attempt += 1) {
        await tap('email field', (v) => v === 'Email address' || v === 'Boat account email' || v.startsWith('u'));
        await sh('input keyevent KEYCODE_MOVE_END');
        for (let i = 0; i < 40; i += 1) await sh('input keyevent KEYCODE_DEL');
        for (const chunk of EMAIL.match(/.{1,4}/g)) { await sh(`input text '${chunk}'`); await sleep(300); }
        if (find(await screen(), (v) => v === EMAIL)) break;
        if (attempt === 2) throw new Error('the email field never held the whole address');
        say('the email field lost keys; typing it again');
    }
    await sh('input keyevent KEYCODE_ESCAPE').catch(() => undefined);
    await tap('Connect Boat account', (v) => v === 'Connect Boat account');
    await tap('Sign in to Boat', (v) => v === 'Sign in to Boat');
    await sleep(4000);
    say(`after Sign in to Boat: ${await focused()}`);
    await bringMuxrBack();
    await waitFor('Boat account Connected', (found) => find(found, (v) => v === 'Connected') !== undefined);
    if (opts.dp !== '390' || opts.font !== '1.0' || opts.theme !== 'light') {
        await view(opts.dp, opts.font, opts.theme);
        await sh(`am force-stop ${PKG}`);
        await bringMuxrBack();
        await tap('Cloud computer', (v) => v === 'Cloud computer' || v === 'Add a cloud computer. Boat.', 180);
        await waitFor('the size step with the linked account', (found) => find(found, (v) => v === 'Connected') !== undefined);
    }
    await shot('01-size-and-price');

    if (opts.upstream) {
        before = await machineIds();
        say(`machines on the account before Create: ${before.size}`);
    }
    await tap('Create cloud computer', (v) => v === 'Create cloud computer');
    created = Date.now();
    say('from here the journey taps nothing in muxr; no browser may open');
    // Each set-up step's words, in order, as the checklist shows them.
    const STEPS = [
        ['02-creating', (v) => v === 'Creating your cloud computer on Boat.' || v === 'Starting your cloud computer.'],
        ['03-installing', (v) => /^Putting muxr on|^Installing/.test(v)],
        ['04-configuring', (v) => v === 'Setting up muxr on your cloud computer.'],
        ['05-private-connection', (v) => v === 'Connecting this phone to your cloud computer over a private SSH link.'],
        ['06-pairing', (v) => v === 'Connecting this device to muxr.'],
    ];
    const seen = new Set();
    let home = false;
    while (Date.now() - created < 600_000) {
        const focus = await focused();
        const found = await screen();
        if (await answerAnr(found)) continue;
        if (!focus.includes(PKG)) { await shot('07-left-muxr'); throw new Error(`something opened over muxr during set-up: ${focus}`); }
        for (const [name, test] of STEPS) {
            if (seen.has(name) || find(found, test) === undefined) continue;
            seen.add(name);
            await shot(name);
            say(`step: ${name}`);
        }
        // A short viewport keeps the active step below the fold; follow it as a person would, with a scroll.
        if (Number(opts.dp) < 390 && seen.size < STEPS.length && find(found, (v) => v === 'Your cloud computer')) await sh('input swipe 540 1800 540 700 300');
        if (find(found, (v) => v === 'Try again')) { await shot('07-setup-failed'); throw new Error(`set-up failed: ${found.filter((n) => n.text).map((n) => n.text).join(' | ')}`); }
        if (find(found, (v) => v.includes('connected')) && find(found, (v) => v === 'Plan, ask, build…')) { home = true; break; }
        await sleep(1500);
    }
    if (!home) throw new Error('the phone never reached Home with the computer connected');
    await sleep(3000);
    await shot('07-home-connected');
    say(`PASS: Home connected ${Math.round((Date.now() - created) / 1000)} s after Create, over SSH, no browser opened; steps seen: ${[...seen].join(', ')}`);
    if (!seen.has('05-private-connection')) throw new Error('the Private connection step was never shown');
    writeFileSync(join(EVIDENCE, 'steps.json'), JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: opts.upstream ? `fresh release APK on an owned 390 dp emulator, a real Boat machine through the lab's key proxy to ${opts.upstream}` : 'fresh release APK on an owned 390 dp emulator, Boat lab with its stand-in computer (sshd + muxr in a namespace)',
        steps: ['open Cloud computer', 'link the Boat account (umer@example.com)', 'tap Create cloud computer', 'tap nothing else in muxr'],
        result: 'set-up ran Create, Put muxr on it, Private connection (SSH) and Pair with no browser, and the phone landed on Home connected',
    }, null, 2));
    if (opts.screen) await screenPhase();
} catch (error) {
    say(`FAIL: ${error.message}`);
    process.exitCode = 1;
    // A held run keeps the phone and the machine for a fix and `--attach`, but never lets a real machine bill past 50 minutes.
    const until = Math.min(Date.now() + Number(opts.hold) * 1000, created > 0 ? created + 50 * 60_000 : Infinity);
    if (Date.now() < until) say(`holding the phone ${serial} and the machine until ${new Date(until).toISOString()} or ${join(EVIDENCE, 'release')}`);
    while (Date.now() < until) {
        try { readFileSync(join(EVIDENCE, 'release')); say('released'); break; } catch { await sleep(5000); }
    }
} finally {
    if (recorder) await stopRecording().catch((error) => say(`recording pull failed: ${error.message}`));
    recorder?.kill();
    // A real machine bills while it lives: remove every one this run created and read the account back.
    if (before) {
        try {
            for (const ref of await account.list()) {
                if (before.has(ref.id)) continue;
                await account.remove(ref, ref.id);
                say('removed the machine this run created');
            }
            const left = [...await machineIds()].filter((id) => !before.has(id));
            say(left.length === 0 ? 'no machine from this run is left on the account' : `STILL ON THE ACCOUNT: ${left.length} machine(s) from this run`);
        } catch (error) {
            say(`MACHINE REMOVAL FAILED: ${error.message}`);
        }
    }
    if (emulator) await emulator.stop().catch((error) => say(`emulator stop failed: ${error.message}`));
    if (lab) {
        lab.kill('SIGTERM');
        await new Promise((done) => (lab.exitCode !== null ? done() : lab.once('exit', done)));
        say(`boat lab ${lab.pid} stopped`);
        // Only once its processes are gone: the stand-in's sshd, relay and host live under this folder.
        if (opts.machine) rmSync(resolve(opts.machine), { recursive: true, force: true });
    }
}
