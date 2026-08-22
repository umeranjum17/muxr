#!/usr/bin/env node
// Runs one take: desk and phone recorded together while the job actually runs.
//
//   node capture/take.mjs
//
// One continuous take, per §3.3. Both recorders start before the prompt is sent
// and stop after the job finishes, so every shot in the film is cut from the
// same two files and the continuity rule holds by construction rather than by
// care.
//
// The phone is tapped by coordinate resolved beforehand: `uiautomator dump`
// competes with `adb screenrecord` for the device and gets killed mid-take.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAKE = path.join(root, 'raw/take');

const AGENT = 'auth-fix';
const SERIAL = 'emulator-5554';
/** Resolved by `tap.mjs "Enter" --print` while the recorder is not running. */
const ENTER = [476, 2112];

const TASK = 'There is a refresh-token race in src/auth/token-store.ts: two '
    + 'concurrent redemptions of the same refresh token both succeed, so one '
    + 'session can be forked into two. Find it and fix it, then run pnpm test.';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const adb = (args) => exec('adb', ['-s', SERIAL, ...args], { maxBuffer: 1 << 26 });
const screen = () => exec('herdr', ['agent', 'read', AGENT, '--source', 'visible'],
    { maxBuffer: 1 << 24 }).then((r) => r.stdout).catch(() => '');

/** Waits for `match` to hold on the pane, or gives up after `limit` seconds. */
async function until(label, match, limit) {
    const deadline = Date.now() + limit * 1000;
    while (Date.now() < deadline) {
        const text = await screen();
        if (match(text)) return ((limit * 1000 - (deadline - Date.now())) / 1000);
        await wait(700);
    }
    throw new Error(`timed out after ${limit}s waiting for ${label}`);
}

await mkdir(TAKE, { recursive: true });
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

// Both recorders come up first and are given a moment to settle, so the take
// opens on a still terminal rather than on the first frame of the prompt.
const desk = spawn('node', [path.join(root, 'capture/deskpoll.mjs'), AGENT,
    path.join(TAKE, 'desk.cast'), '--fps', '12', '--cols', '54', '--rows', '23'],
    { stdio: 'inherit' });
const phone = spawn('adb', ['-s', SERIAL, 'shell', 'screenrecord',
    '--bit-rate', '20000000', '--time-limit', '180', '/sdcard/phone.mp4'],
    { stdio: 'inherit' });
await wait(3000);
console.log(`${at()} recording`);

await exec('herdr', ['agent', 'prompt', AGENT, TASK]);
console.log(`${at()} prompt sent`);

// The only permission Claude can be stopped by here is the test command:
// edits are auto-accepted and reads never prompt.
await until('the approval prompt',
    (t) => /Do you want|wants to run|1\. Yes/.test(t), 240);
console.log(`${at()} BLOCKED`);

// Nobody is at the desk.
//
// Forty-five seconds, and deliberately not longer. Shot 03 shows the wait as a
// counter, and that number is read two ways at once: how long the desk failed,
// and how fast the phone caught it. Under about half a minute it reads as
// someone briefly looking away; past a minute the second reading turns against
// the product, which starts to look slow at its own job.
await wait(45000);
await adb(['shell', 'input', 'tap', String(ENTER[0]), String(ENTER[1])]);
console.log(`${at()} answered from the phone`);

await until('the tests to finish',
    (t) => /Tests:\s+\d+ passed/.test(t) || /\d+ passed, \d+ total/.test(t), 300);
console.log(`${at()} tests done`);

// Let the finished state hold — shot 08 wants a full second of stillness after
// it arrives, and a recorder stopped on the frame it lands has nothing to cut.
await wait(10000);

phone.kill('SIGINT');
desk.kill('SIGINT');
await wait(4000);
await adb(['pull', '/sdcard/phone.mp4', path.join(TAKE, 'phone.mp4')]);
console.log(`${at()} done — raw/take/desk.cast, raw/take/phone.mp4`);
process.exit(0);
