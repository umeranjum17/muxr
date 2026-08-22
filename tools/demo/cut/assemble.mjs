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
import { SHOTS, TOTAL_FRAMES, FPS, LOOP, DISSOLVE } from '../lib/film.mjs';

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
    // The shot feeding the dissolve is cut longer by exactly the overlap.
    const want = shot.frames + (shot.id === DISSOLVE.from ? DISSOLVE.frames : 0);
    try {
        await access(file);
        const got = await frames(file);
        if (got !== want) missing.push(`${shot.id}: ${got} frames, expected ${want}`);
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

// The film's one soft edit is baked here: the dissolve's two shots become a
// single segment, blended over exactly the overlap the longer cut carries, so
// the segment is as long as the two table entries together and the total
// cannot drift.
const segment = path.join(root, 'raw/.dissolve.mp4');
const fromShot = SHOTS.find((s) => s.id === DISSOLVE.from);
await exec('ffmpeg', ['-v', 'error',
    '-i', path.join(root, 'cut/shots', `${DISSOLVE.from}.mp4`),
    '-i', path.join(root, 'cut/shots', `${DISSOLVE.into}.mp4`),
    '-filter_complex', `[0][1]xfade=transition=fade`
        + `:duration=${(DISSOLVE.frames / FPS).toFixed(4)}`
        + `:offset=${(fromShot.frames / FPS).toFixed(4)}`,
    '-r', String(FPS), '-c:v', 'libx264', '-crf', '16', '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-y', segment], { maxBuffer: 1 << 26 });

const list = path.join(root, 'raw/shots.txt');
const line = (file) => `file '${file}'`;
await writeFile(list, [
    ...SHOTS.filter((s) => s.id !== DISSOLVE.from && s.id !== DISSOLVE.into)
        .map((s) => line(path.join(root, 'cut/shots', `${s.id}.mp4`))),
    line(segment),
].join('\n'));

// Concatenated by stream copy: every part is already the same codec, size and
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

// The shipped cut IS the master — stream-copied, not re-encoded. A film of
// fine terminal text has no fat to trade away: the 720p/CRF-20 version this
// used to make read as mush the moment anyone looked closely.
await mkdir(path.join(repo, 'docs/demo'), { recursive: true });
const shipped = path.join(repo, 'docs/demo/muxr-demo.mp4');
await exec('ffmpeg', ['-v', 'error', '-i', master, '-c', 'copy',
    '-movflags', '+faststart', '-an', '-y', shipped]);

// The README loop is cut from this same timeline rather than rendered
// separately, so the two can never drift apart. It opens on the thesis image —
// desk and phone side by side, the tap, the desk reacting — because the loop
// is most visitors' entire impression and "phone controls the desk" has to be
// legible in frame one.
//
// The loop alone carries a quiet corner wordmark. These frames get
// screenshotted and reposted stripped of the README around them; the bug is
// the only branding that travels with the pixels. The film itself stays
// unmarked.
const loop = path.join(repo, 'docs/demo/muxr-loop.webp');
const mono = path.join(repo, 'apps/mobile/sources/assets/fonts/IBMPlexMono-Regular.ttf');
// 960 wide at q82: the README column renders the loop at ~830px, so 720
// meant upscaling lossy pixels. Quality is spent here deliberately — this is
// the one moving thing most visitors ever see.
await exec('ffmpeg', ['-v', 'error', '-ss', String(LOOP.start / FPS), '-i', master,
    '-t', String(LOOP.frames / FPS),
    '-vf', `fps=20,scale=960:-2:flags=lanczos,drawtext=fontfile=${mono}:text=muxr`
        + `:fontsize=26:fontcolor=0xececec@0.75:borderw=1:bordercolor=0x0a0a0b@0.8`
        + `:x=w-tw-20:y=h-th-16`,
    '-c:v', 'libwebp', '-lossless', '0', '-q:v', '82', '-loop', '0', '-an', '-y', loop]);

console.log('docs/demo/muxr-demo.mp4  1080p master, stream-copied');
console.log(`docs/demo/muxr-loop.webp frames ${LOOP.start}-${LOOP.start + LOOP.frames}, ${(LOOP.frames / FPS).toFixed(1)}s`);
