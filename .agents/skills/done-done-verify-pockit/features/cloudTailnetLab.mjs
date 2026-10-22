// The Tailscale sign-in of a new Boat cloud computer opens by itself (cloud-computer-onboarding.md,
// tailnet-sign-in). Boots a task-owned emulator, runs boatSignInLab.mjs with its Tailscale stand-in,
// links the lab Boat account on a release APK built with EXPO_PUBLIC_MUXR_BOAT_API, taps Create
// cloud computer and then nothing in muxr: the browser must come up on the Tailscale sign-in page
// by itself, and once the lab joins, setup must move on to muxr's own set-up (where the lab stops it).
// Run from the repo root:
//   node .agents/skills/done-done-verify-pockit/features/cloudTailnetLab.mjs --apk <apk> --evidence <dir> --avd-home <dir> --port <boat lab port>
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dismissPrompts, dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' }, port: { type: 'string' },
} });
if (!opts.apk || !opts.evidence || !opts['avd-home'] || !opts.port) throw new Error('--apk, --evidence, --avd-home and --port are required');
const PKG = 'com.trymuxr.app';
const LOGIN = 'https://login.tailscale.com/a/umer-lab';
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
    const [l, t, r, b] = find(await waitFor(what, (found) => find(found, test) !== undefined, seconds), test).box;
    say(`tap ${what}`);
    await sh(`input tap ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)}`);
    await sleep(1500);
}
const focused = async () => (await sh('dumpsys window displays')).match(/mCurrentFocus=.*/)?.[0] ?? '';
let activity = '';
const bringMuxrBack = async () => { await sh(`am start -n ${activity}`); await sleep(2000); };

let lab;
let emulator;
try {
    lab = spawn(process.execPath, ['.agents/skills/done-done-verify-pockit/features/boatSignInLab.mjs', opts.port], {
        env: { ...process.env, BOAT_LAB_TAILSCALE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    lab.stdout.on('data', (chunk) => appendFileSync(join(EVIDENCE, 'boat-lab.log'), chunk));
    lab.stderr.on('data', (chunk) => appendFileSync(join(EVIDENCE, 'boat-lab.log'), chunk));
    say(`boat lab pid ${lab.pid} on port ${opts.port}`);

    emulator = await bootOwnedEmulator({ name: 'mxts', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    await adb(['reverse', `tcp:${opts.port}`, `tcp:${opts.port}`]);
    // Chrome's first-run screens would stand in front of every page it opens.
    await sh(`echo 'chrome --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line`);
    await sh('am set-debug-app --persistent com.android.chrome');
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => undefined);
    activity = (await sh(`cmd package resolve-activity --brief ${PKG}`)).trim().split('\n').pop();
    await bringMuxrBack();
    await dismissPrompts().catch(() => undefined);

    await tap('Cloud computer', (v) => v === 'Cloud computer' || v === 'Add a cloud computer. Boat.', 180);
    await tap('email field', (v) => v === 'Email address' || v === 'Boat account email');
    await sh('input text umer@example.com');
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
    say('from here the journey taps nothing in muxr until the browser has opened by itself');
    let frame = 0;
    let opened = '';
    while (Date.now() - created < 240_000) {
        const focus = await focused();
        if (frame % 3 === 0 || !focus.includes(PKG)) await shot(`02-after-create-${String(frame).padStart(2, '0')}`);
        frame += 1;
        if (!focus.includes(PKG) && /chrome|browser/i.test(focus)) { opened = focus; break; }
        await sleep(2000);
    }
    if (!opened) throw new Error('the browser never opened on its own after Create cloud computer');
    say(`browser opened by itself ${Math.round((Date.now() - created) / 1000)} s after Create: ${opened}`);
    await sleep(3000);
    const intent = (await sh('dumpsys activity activities')).split('\n').find((line) => line.includes('login.tailscale.com')) ?? '';
    say(`browser task: ${intent.trim()}`);
    if (!intent.includes(LOGIN)) throw new Error(`the browser did not open ${LOGIN}`);
    await shot('03-tailscale-page-opened-by-itself');

    // The person approves on Tailscale's page (the lab joins 20 s after the link) and comes back.
    await bringMuxrBack();
    await shot('04-back-in-muxr');
    await waitFor('setup past the tailnet join', (found) => find(found, (v) => v.startsWith('muxr could not set itself up there')) !== undefined, 120);
    await shot('05-joined-then-lab-stops');
    say('PASS: Tailscale sign-in opened with no tap in muxr, and setup went on past the tailnet join');
    writeFileSync(join(EVIDENCE, 'steps.json'), JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: 'fresh release APK on an owned emulator, Boat lab with its Tailscale stand-in',
        steps: ['open Cloud computer', 'link the Boat account (umer@example.com)', 'tap Create cloud computer', 'tap nothing else in muxr', 'approve on the Tailscale page that opened', 'come back to muxr'],
        result: 'the browser opened the Tailscale sign-in page by itself, and setup went on past Join your tailnet',
    }, null, 2));
} finally {
    if (emulator) await emulator.stop().catch((error) => say(`emulator stop failed: ${error.message}`));
    if (lab) {
        lab.kill('SIGTERM');
        await new Promise((done) => (lab.exitCode !== null ? done() : lab.once('exit', done)));
        say(`boat lab ${lab.pid} stopped`);
    }
}
