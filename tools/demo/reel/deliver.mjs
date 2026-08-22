#!/usr/bin/env node
// Ships the rendered master.
//
//   node reel/deliver.mjs
//
// The shipped mp4 IS the master with a faststart header — no second encode; a
// film of fine terminal text has no quality to trade away. The README loop is
// the phone act — context card, reveal, priming card, the tap — cut from the
// same master, with the one corner wordmark these frames carry when they
// travel without the README around them.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '../..');

// The acts, on the composition's clock. Keep in step with reel/src/config.ts.
const FPS = 60;
const LOOP = { from: 1020, frames: 540 };  // the approval and the run

const master = path.join(root, 'raw/muxr-demo-1080.mp4');
await mkdir(path.join(repo, 'docs/demo'), { recursive: true });

await exec('ffmpeg', ['-v', 'error', '-i', master, '-c', 'copy',
    '-movflags', '+faststart', '-an', '-y', path.join(repo, 'docs/demo/muxr-demo.mp4')]);

const mono = path.join(repo, 'apps/mobile/sources/assets/fonts/IBMPlexMono-Regular.ttf');
await exec('ffmpeg', ['-v', 'error',
    '-ss', String(LOOP.from / FPS), '-i', master, '-t', String(LOOP.frames / FPS),
    '-vf', `fps=24,scale=960:-2:flags=lanczos,drawtext=fontfile=${mono}:text=muxr`
        + `:fontsize=26:fontcolor=0xececec@0.75:borderw=1:bordercolor=0x0a0a0b@0.8`
        + `:x=w-tw-20:y=h-th-16`,
    '-c:v', 'libwebp', '-lossless', '0', '-q:v', '82', '-loop', '0', '-an', '-y',
    path.join(repo, 'docs/demo/muxr-loop.webp')]);

console.log('docs/demo/muxr-demo.mp4  1080p60 master, stream-copied');
console.log(`docs/demo/muxr-loop.webp frames ${LOOP.from}-${LOOP.from + LOOP.frames}, ${(LOOP.frames / FPS).toFixed(1)}s`);
