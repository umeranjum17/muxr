#!/usr/bin/env node
// The phone pass for shots 08, 09 and 10.
//
//   node capture/phone-after.mjs <gitX> <gitY> <commitX> <commitY>
//
// The take is one continuous run of the job and the job never navigates
// anywhere — it sits on the session the whole time. Shots 08, 09 and 10 are
// someone picking the phone up afterwards and looking: what it came to, the
// diff, and the herd it came back to. Same session, same repo, same commit, so
// §4's continuity holds; only the recording is separate.
//
// Coordinates are passed in because `uiautomator dump` fights `adb screenrecord`
// for the device and is killed mid-recording. Resolve them with
// `capture/tap.mjs "<label>" --print` while nothing is recording.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERIAL = 'emulator-5554';

const [gitX, gitY, commitX, commitY] = process.argv.slice(2).map(Number);
if ([gitX, gitY, commitX, commitY].some(Number.isNaN)) {
    console.error('usage: phone-after.mjs <gitX> <gitY> <commitX> <commitY>');
    process.exit(2);
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const adb = (args) => exec('adb', ['-s', SERIAL, ...args], { maxBuffer: 1 << 26 });
const tap = (x, y) => adb(['shell', 'input', 'tap', String(x), String(y)]);
const swipe = (x1, y1, x2, y2, ms) =>
    adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)]);

const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

// The app is already on the session, scrolled to the bottom, before recording:
// shot 08 is the finished state holding still, not the journey to it.
const rec = spawn('adb', ['-s', SERIAL, 'shell', 'screenrecord',
    '--bit-rate', '20000000', '--time-limit', '90', '/sdcard/phone-after.mp4'],
    { stdio: 'inherit' });
await wait(3000);
console.log(`${at()} finished state`);
await wait(7000);

// 09 — the diff, in the light the Code panel renders it in.
await tap(gitX, gitY);
await wait(4500);
await tap(commitX, commitY);
await wait(8000);
console.log(`${at()} diff`);

// 10 — back out to the herd, where the session sits among the others.
await tap(69, 202);
await wait(2500);
await tap(69, 202);
await wait(3000);
for (let i = 0; i < 5; i += 1) {
    await swipe(540, 1900, 540, 600, 260);
    await wait(500);
}
await wait(7000);
console.log(`${at()} herd`);

rec.kill('SIGINT');
await wait(4000);
await adb(['pull', '/sdcard/phone-after.mp4', path.join(root, 'raw/take/phone-after.mp4')]);
console.log(`${at()} raw/take/phone-after.mp4`);
process.exit(0);
