#!/usr/bin/env node
// Cuts the film's source windows out of the raw recordings.
//
//   node cut/shots.mjs
//
// Each window is taken at the moment the app is actually doing something,
// found by cut/moments.mjs rather than configured — see lib/moments.json. A
// window may be pinned with an explicit `start` when the shot needs a specific
// state on screen rather than the liveliest one.
//
// The filter order matters and is the reason earlier cuts were near-still:
// `screenrecord` writes variable-rate video and emits nothing at all while the
// UI is settled, so trimming before the frame rate is normalised returns the
// single frame that was being held. fps= must come first.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'reel/public/film');

const shots = JSON.parse(await readFile(path.join(root, 'lib/shots.json'), 'utf8'));
const moments = JSON.parse(await readFile(path.join(root, 'lib/moments.json'), 'utf8'));

/** The best window of exactly this length, interpolated from the scored sizes. */
function startFor(src, seconds) {
    const best = moments[src]?.best;
    if (!best) return 0;
    const sizes = Object.keys(best).map(Number).sort((a, b) => a - b);
    const nearest = sizes.reduce((a, b) => (Math.abs(b - seconds) < Math.abs(a - seconds) ? b : a));
    return best[String(nearest)] ?? best[nearest] ?? 0;
}

await mkdir(OUT, { recursive: true });
for (const [id, win] of Object.entries(shots.windows)) {
    const seconds = win.frames / shots.fps;
    const start = win.start ?? startFor(win.src, seconds);
    const file = path.join(OUT, `${id}.mp4`);
    await exec('ffmpeg', [
        '-v', 'error', '-i', path.join(root, 'raw', `${win.src}.mp4`),
        '-vf', [
            `fps=${shots.fps}`,
            `trim=start=${start.toFixed(3)}:duration=${(seconds + 0.2).toFixed(3)}`,
            'setpts=PTS-STARTPTS',
            'format=yuv420p',
        ].join(','),
        '-frames:v', String(win.frames),
        '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-y', file,
    ]);
    console.log(`  ${id.padEnd(11)} ${win.src.padEnd(16)} @${String(start).padStart(6)}s  ${win.frames}f`);
}
console.log(`\nreel/public/film — ${Object.keys(shots.windows).length} windows`);
