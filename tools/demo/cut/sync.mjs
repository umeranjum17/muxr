#!/usr/bin/env node
// Finds the frame where a region of a video changes, to the frame.
//
//   node cut/sync.mjs raw/take/phone-cfr.mp4 44 50 "1080:900:0:1100"
//
// Shot 05 puts the desk and the phone side by side and the brief allows eight
// frames between the tap and the desk reacting. Eyeballing a sample every few
// seconds cannot resolve that, so the two recordings are aligned by finding the
// exact frame each one changes on and subtracting.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const [, , file, from, to, crop] = process.argv;
if (!file || from === undefined || to === undefined) {
    console.error('usage: sync.mjs <video> <fromSec> <toSec> [crop]');
    process.exit(2);
}

const filters = [crop ? `crop=${crop}` : null, 'scale=240:-1', 'format=gray',
    'tblend=all_mode=difference', 'signalstats',
    'metadata=print:key=lavfi.signalstats.YAVG'].filter(Boolean).join(',');

const { stderr } = await exec('ffmpeg', ['-v', 'info', '-ss', String(from),
    '-to', String(to), '-i', file, '-vf', filters, '-f', 'null', '-'],
    { maxBuffer: 1 << 26 });

const scores = [];
let time = 0;
for (const line of stderr.split('\n')) {
    const stamp = line.match(/pts_time:([\d.]+)/);
    if (stamp) time = Number(stamp[1]);
    const value = line.match(/YAVG=([\d.]+)/);
    if (value) scores.push({ at: Number(from) + time, score: Number(value[1]) });
}

scores.sort((a, b) => b.score - a.score);
for (const { at, score } of scores.slice(0, 6)) {
    console.log(`${at.toFixed(3)}s  frame ${Math.round(at * 30)}  ${score.toFixed(2)}`);
}
