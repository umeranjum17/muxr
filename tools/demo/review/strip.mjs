#!/usr/bin/env node
// Contact sheet for judging motion.
//
//   node review/strip.mjs <video> <startSec> <endSec> [count] [out.png]
//
// Pulls `count` frames evenly across the window and tiles them left to right
// with their timestamps burned in. Watching a video tells you whether motion
// looks nice; a strip tells you where the frames actually *are*, which is the
// only way to see easing. Even spacing across a strip means linear — the tell
// the rubric fails an entrance for.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const [, , video, startArg, endArg, countArg = '10', out = 'review/frames/strip.png'] = process.argv;
if (!video) { console.error('usage: strip.mjs <video> <start> <end> [count] [out]'); process.exit(1); }

const start = Number(startArg);
const end = Number(endArg);
const count = Number(countArg);
const dir = await mkdtemp(path.join(tmpdir(), 'strip-'));

try {
    const times = Array.from({ length: count }, (_, i) => start + ((end - start) * i) / (count - 1));
    for (const [i, t] of times.entries()) {
        await exec('ffmpeg', [
            '-v', 'error', '-ss', t.toFixed(4), '-i', video, '-frames:v', '1',
            '-vf', [
                'scale=480:-1',
                // The timestamp is burned in so a judge can quote a frame
                // rather than describe "the third one".
                `drawtext=text='${t.toFixed(3)}s':x=10:y=10:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=6`,
            ].join(','),
            '-y', path.join(dir, `f${String(i).padStart(2, '0')}.png`),
        ]);
    }
    const cols = Math.min(count, 5);
    await exec('ffmpeg', [
        '-v', 'error', '-i', path.join(dir, 'f%02d.png'),
        '-filter_complex', `tile=${cols}x${Math.ceil(count / cols)}:margin=8:padding=8:color=0x111113`,
        '-y', out,
    ]);
    console.log(`${out}  ${count} frames  ${start}s..${end}s`);
} finally {
    await rm(dir, { recursive: true, force: true });
}
