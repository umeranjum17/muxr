#!/usr/bin/env node
// Puts the rendered film and frames where the README and the Play listing
// expect them.
//
//   node build-assets.mjs
//
// The 1080p master stays untracked: forty seconds of fine terminal text is
// ~110MB at a CRF worth keeping, and that does not belong in every clone.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const MASTER = path.join(here, 'raw/muxr-film.mp4');

const ORDER = ['herd', 'terminal', 'voice', 'changes', 'connection', 'usage', 'plugins', 'inbox'];

await mkdir(path.join(repo, 'docs/demo'), { recursive: true });
await mkdir(path.join(repo, 'docs/play/store-assets'), { recursive: true });
await mkdir(path.join(repo, 'docs/screenshots/v0112/dark'), { recursive: true });
await mkdir(path.join(repo, 'docs/screenshots/v0112/light'), { recursive: true });

// 720p for the repo and the site. Slow preset because this encodes once.
await exec('ffmpeg', ['-v', 'error', '-i', MASTER, '-vf', 'scale=1280:-2',
    '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an', '-y', path.join(repo, 'docs/demo/muxr-demo.mp4')]);

// The README loop: the first three beats, which are the ones that establish
// what the product is. GitHub will not play a repo-hosted mp4 inline, but it
// animates a webp, so the hero has to be one.
await exec('ffmpeg', ['-v', 'error', '-i', MASTER, '-t', '9', '-vf', 'fps=16,scale=720:-2',
    '-c:v', 'libwebp', '-lossless', '0', '-q:v', '62', '-loop', '0', '-an', '-y',
    path.join(repo, 'docs/demo/muxr-loop.webp')]);

for (const [index, id] of ORDER.entries()) {
    await copyFile(
        path.join(here, `review/frames/store-${id}.png`),
        path.join(repo, `docs/play/store-assets/${String(index + 1).padStart(2, '0')}-${id}.png`),
    );
}

// README screenshots come straight off the device, not from a composition:
// they are evidence, and a composed frame is a design artefact.
const README_SHOTS = [['dark', 'herd'], ['dark', 'voice'], ['light', 'changes'], ['dark', 'connection']];
for (const [theme, id] of README_SHOTS) {
    await copyFile(
        path.join(here, `reel/public/stills/${theme}/${id}.png`),
        path.join(repo, `docs/screenshots/v0112/${theme}/${id}.png`),
    );
}

const size = async (rel) => `${((await readFile(path.join(repo, rel))).length / 1024 / 1024).toFixed(1)} MB`;
console.log(`docs/demo/muxr-demo.mp4    ${await size('docs/demo/muxr-demo.mp4')}`);
console.log(`docs/demo/muxr-loop.webp   ${await size('docs/demo/muxr-loop.webp')}`);
console.log(`docs/play/store-assets     ${ORDER.length} frames`);
console.log(`docs/screenshots/v0112     ${README_SHOTS.length} captures`);
