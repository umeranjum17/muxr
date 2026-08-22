#!/usr/bin/env node
// Assembles the film from the cut shots.
//
//   node cut/assemble.mjs
//
// Reads the shot table in lib/film.mjs and nothing else — the table decides
// order and length, so retiming the film is editing that file. Every shot is
// checked against its declared length before anything is concatenated, because
// a shot that is one frame short shifts every cut after it and the mistake is
// invisible until the whole thing is watched end to end.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, TOTAL_FRAMES, FPS, LOOP } from '../lib/film.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');

const frames = async (file) => {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v',
        '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
    return Number(stdout.trim());
};

const missing = [];
for (const shot of SHOTS) {
    const file = path.join(root, 'cut/shots', `${shot.id}.mp4`);
    try {
        await access(file);
        const got = await frames(file);
        if (got !== shot.frames) missing.push(`${shot.id}: ${got} frames, table says ${shot.frames}`);
    } catch {
        missing.push(`${shot.id}: not cut yet`);
    }
}
if (missing.length > 0) {
    console.error('cannot assemble:');
    for (const problem of missing) console.error(`  ${problem}`);
    process.exit(1);
}

await mkdir(path.join(root, 'raw'), { recursive: true });
const list = path.join(root, 'raw/shots.txt');
await writeFile(list, SHOTS.map((s) => `file '${path.join(root, 'cut/shots', `${s.id}.mp4`)}'`).join('\n'));

// Concatenated by stream copy: every shot is already the same codec, size and
// rate, so the film is assembled without a second generation of encoding.
const master = path.join(root, 'raw/muxr-demo-1080.mp4');
await exec('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-c', 'copy', '-y', master]);

const total = await frames(master);
if (total !== TOTAL_FRAMES) {
    console.error(`assembled ${total} frames, table says ${TOTAL_FRAMES}`);
    process.exit(1);
}
console.log(`raw/muxr-demo-1080.mp4 — ${total} frames, ${(total / FPS).toFixed(1)}s`);

// The shipped cut: 720p for the README and the site.
await mkdir(path.join(repo, 'docs/demo'), { recursive: true });
const shipped = path.join(repo, 'docs/demo/muxr-demo.mp4');
await exec('ffmpeg', ['-v', 'error', '-i', master, '-vf', 'scale=1280:-2',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an', '-y', shipped]);

// The README loop is shots 01-03, cut from this same timeline rather than
// rendered separately, so the two can never drift apart.
const loop = path.join(repo, 'docs/demo/muxr-loop.webp');
await exec('ffmpeg', ['-v', 'error', '-i', master,
    '-t', String(LOOP.frames / FPS), '-vf', 'fps=16,scale=720:-2',
    '-c:v', 'libwebp', '-lossless', '0', '-q:v', '62', '-loop', '0', '-an', '-y', loop]);

console.log(`docs/demo/muxr-demo.mp4  720p`);
console.log(`docs/demo/muxr-loop.webp shots 01-03, ${(LOOP.frames / FPS).toFixed(1)}s`);
