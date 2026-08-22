#!/usr/bin/env node
// Second phone pass: the screens the take never visited.
//
//   node capture/phone-b.mjs
//
// The take is one continuous run of the job, and the job never navigates
// anywhere — it sits on the session. Shots 08, 09 and 10 are someone picking
// the phone up afterwards and looking: the notification, the diff, the herd.
// Same session, same repo, same commit, so §4's continuity holds; only the
// recording is separate.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERIAL = 'emulator-5554';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const adb = (args) => exec('adb', ['-s', SERIAL, ...args], { maxBuffer: 1 << 26 });
const tap = (x, y) => adb(['shell', 'input', 'tap', String(x), String(y)]);
const swipe = (x1, y1, x2, y2, ms) =>
    adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)]);

// Positions resolved beforehand: `uiautomator dump` fights `adb screenrecord`
// for the device and is killed mid-recording.
const GIT = [155, 2112];      // "Git history" in the scrolled key row
const COMMIT = [540, 490];    // the newest commit in the Code panel
const BACK = [69, 202];

/** Everything below runs against the recorder, so each beat is given time. */
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const rec = spawn('adb', ['-s', SERIAL, 'shell', 'screenrecord',
    '--bit-rate', '20000000', '--time-limit', '90', '/sdcard/phone-b.mp4'],
    { stdio: 'inherit' });
await wait(3000);

// 08 — the notification arrives, then the finished session behind it.
await adb(['shell', 'cmd', 'statusbar', 'expand-notifications']);
await wait(4500);
console.log(`${at()} notification`);
await adb(['shell', 'cmd', 'statusbar', 'collapse']);
await wait(5000);
console.log(`${at()} finished state`);

// 09 — the diff, in the light Code panel.
await tap(...GIT);
await wait(4000);
await tap(...COMMIT);
await wait(6000);
console.log(`${at()} diff`);
// A slow read down the hunk: the added line is what the shot is about.
await swipe(540, 1500, 540, 1150, 900);
await wait(4000);
console.log(`${at()} diff scrolled`);

// 10 — back out to the herd, where the session sits among the others.
await tap(...BACK);
await wait(2500);
await tap(...BACK);
await wait(2500);
await tap(...BACK);
await wait(3000);
for (let i = 0; i < 5; i += 1) {
    await swipe(540, 1900, 540, 600, 260);
    await wait(500);
}
await wait(6000);
console.log(`${at()} herd`);

rec.kill('SIGINT');
await wait(4000);
await adb(['pull', '/sdcard/phone-b.mp4', path.join(root, 'raw/take/phone-b.mp4')]);
console.log(`${at()} raw/take/phone-b.mp4`);
process.exit(0);
