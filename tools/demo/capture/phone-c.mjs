#!/usr/bin/env node
// Third phone pass: the bottom of the session, where the answer is.
//
//   node capture/phone-c.mjs
//
// Pass B left the transcript scrolled part-way up, so the line the whole film
// is heading towards — the test result — was below the fold. This walks to the
// bottom and holds there.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERIAL = 'emulator-5554';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const adb = (args) => exec('adb', ['-s', SERIAL, ...args], { maxBuffer: 1 << 26 });

// The app is already on the session, scrolled to the bottom, before recording:
// the shot is the finished state holding still, not the journey to it.
const rec = spawn('adb', ['-s', SERIAL, 'shell', 'screenrecord',
    '--bit-rate', '20000000', '--time-limit', '30', '/sdcard/phone-c.mp4'],
    { stdio: 'inherit' });
await wait(14000);

rec.kill('SIGINT');
await wait(4000);
await adb(['pull', '/sdcard/phone-c.mp4', path.join(root, 'raw/take/phone-c.mp4')]);
console.log('raw/take/phone-c.mp4');
process.exit(0);
