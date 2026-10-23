// A new Boat cloud computer set up from the phone over SSH, with no tailnet (cloud-computer-onboarding, ssh-route).
// Boots a task-owned emulator at 390 dp, runs boatSignInLab.mjs with its stand-in computer (BOAT_LAB_SSH: a real sshd
// and this checkout's muxr in a namespace of their own), links the lab Boat account on a release APK built with
// EXPO_PUBLIC_MUXR_BOAT_API, taps Create cloud computer and then nothing in muxr: no browser may open, each set-up
// step is captured, and the phone must land on Home with the computer connected through the SSH tunnel.
// Needs a provisioned Herdr lab (HERDR_LAB_HELPER, HERDR_LAB_SESSION). Run from the repo root:
//   node .agents/skills/done-done-verify-pockit/features/cloudSetupLab.mjs --apk <apk> --evidence <dir> --avd-home <dir> --port <boat lab port> --machine <short dir>
//     [--dp 390|270] [--font 1.0|2.0] [--theme light|dark]
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dismissPrompts, dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' }, port: { type: 'string' }, machine: { type: 'string' },
    dp: { type: 'string', default: '390' }, font: { type: 'string', default: '1.0' }, theme: { type: 'string', default: 'light' },
} });
if (!opts.apk || !opts.evidence || !opts['avd-home'] || !opts.port || !opts.machine) throw new Error('--apk, --evidence, --avd-home, --port and --machine are required');
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
async function waitFor(what, test, seconds = 90) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const found = await screen();
        if (test(found)) return found;
        await sleep(1500);
    }
    await shot(`missing-${what.replace(/\W+/g, '-')}`).catch(() => undefined);
    throw new Error(`${what} never appeared within ${seconds}s`);
}
async function tap(what, test, seconds = 90) {
    // On a short viewport the control can sit below the fold: scroll until it shows.
    for (let i = 0; i < 6 && !(find(await screen(), test)?.box[3] < 2200); i += 1) {
        await sh('input swipe 540 1700 540 900 300');
        await sleep(800);
    }
    const [l, t, r, b] = find(await waitFor(what, (found) => find(found, test) !== undefined, seconds), test).box;
    say(`tap ${what}`);
    await sh(`input tap ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)}`);
    await sleep(1500);
}
const RECORD = "i=0; while [ $i -lt 20 ]; do screenrecord --time-limit 170 --bit-rate 2000000 /sdcard/mxrec-$i.mp4 || break; i=$((i+1)); done";
async function stopRecording() {
    await sh('pkill -INT screenrecord').catch(() => undefined);
    await sleep(3000);
    const files = (await sh('ls /sdcard/ | grep mxrec- || true')).split('\n').map((f) => f.trim()).filter(Boolean).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    for (const [i, file] of files.entries()) await adb(['pull', `/sdcard/${file}`, join(EVIDENCE, `recording-${String(i).padStart(2, '0')}.mp4`)], 120_000);
    say(`recording: ${files.length} file(s)`);
}
const focused = async () => (await sh('dumpsys window displays')).match(/mCurrentFocus=.*/)?.[0] ?? '';
let activity = '';
const bringMuxrBack = async () => { await sh(`am start -n ${activity}`); await sleep(2000); };

let lab;
let emulator;
let recorder;
try {
    lab = spawn(process.execPath, ['.agents/skills/done-done-verify-pockit/features/boatSignInLab.mjs', opts.port], {
        env: { ...process.env, BOAT_LAB_SSH: resolve(opts.machine) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let labOut = '';
    lab.stdout.on('data', (chunk) => { labOut += chunk; appendFileSync(join(EVIDENCE, 'boat-lab.log'), chunk); });
    lab.stderr.on('data', (chunk) => appendFileSync(join(EVIDENCE, 'boat-lab.log'), chunk));
    say(`boat lab pid ${lab.pid} on port ${opts.port}`);
    while (!/BOAT_LAB_SSH_PORT=(\d+)/.test(labOut)) {
        if (lab.exitCode !== null) throw new Error(`the Boat lab stopped: ${labOut}`);
        await sleep(200);
    }
    const sshPort = labOut.match(/BOAT_LAB_SSH_PORT=(\d+)/)[1];
    say(`stand-in computer's SSH on 127.0.0.1:${sshPort}`);

    emulator = await bootOwnedEmulator({ name: 'mxcs', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    // The phone's width in dp is 1080 px * 160 / density: 443 is 390 dp, 640 is 270 dp.
    await sh(`wm density ${Math.round((1080 * 160) / Number(opts.dp))}`);
    await sh(`settings put system font_scale ${opts.font}`);
    await sh(`cmd uimode night ${opts.theme === 'dark' ? 'yes' : 'no'}`);
    say(`view: ${opts.dp} dp, font ${opts.font}, ${opts.theme}`);
    await sh('settings put global heads_up_notifications_enabled 0').catch(() => undefined);
    await adb(['reverse', `tcp:${opts.port}`, `tcp:${opts.port}`]);
    await adb(['reverse', `tcp:${sshPort}`, `tcp:${sshPort}`]);
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
    await shot('01-size-and-price');

    await tap('Create cloud computer', (v) => v === 'Create cloud computer');
    const created = Date.now();
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
        if (!focus.includes(PKG)) { await shot('07-left-muxr'); throw new Error(`something opened over muxr during set-up: ${focus}`); }
        const found = await screen();
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
        start: 'fresh release APK on an owned 390 dp emulator, Boat lab with its stand-in computer (sshd + muxr in a namespace)',
        steps: ['open Cloud computer', 'link the Boat account (umer@example.com)', 'tap Create cloud computer', 'tap nothing else in muxr'],
        result: 'set-up ran Create, Put muxr on it, Private connection (SSH) and Pair with no browser, and the phone landed on Home connected',
    }, null, 2));
} finally {
    if (recorder) await stopRecording().catch((error) => say(`recording pull failed: ${error.message}`));
    recorder?.kill();
    if (emulator) await emulator.stop().catch((error) => say(`emulator stop failed: ${error.message}`));
    if (lab) {
        lab.kill('SIGTERM');
        await new Promise((done) => (lab.exitCode !== null ? done() : lab.once('exit', done)));
        say(`boat lab ${lab.pid} stopped`);
        // Only once its processes are gone: the stand-in's sshd, relay and host live under this folder.
        rmSync(resolve(opts.machine), { recursive: true, force: true });
    }
}
