#!/usr/bin/env node
// Renders the demo reel and the small looping animation the README embeds.
//
// The 1080p master stays out of git — at forty-odd seconds of fine terminal
// text it is north of twenty megabytes, which is not a thing to put in every
// clone. What ships is a 720p web cut and an animated WebP; the master is in
// raw/ for the site and the store listing.
//
// Usage: node reel/render.mjs [Reel|ReelLoop|ReelVertical ...]
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..', '..');
const DOCS = path.join(repo, 'docs/demo');
const RAW = path.join(root, 'raw');
const PUBLIC_DIR = path.join(here, 'public');
const ENTRY = path.join(here, 'src/index.ts');

const TARGETS = {
    Reel: 'muxr-demo-1080.mp4',
    ReelVertical: 'muxr-demo-vertical.mp4',
    ReelLoop: 'muxr-loop.mp4',
};

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', cwd: here });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    });
}

const sizeOf = async (file) => `${((await stat(file)).size / 1e6).toFixed(1)} MB`;

async function render(id) {
    const master = path.join(RAW, TARGETS[id]);
    await run('npx', [
        'remotion', 'render', ENTRY, id, master,
        `--public-dir=${PUBLIC_DIR}`,
        '--concurrency=4',
        '--log=info',
    ]);
    console.log(`--> ${path.relative(repo, master)} (${await sizeOf(master)})`);
    return master;
}

/** The cut that ships: 720p, still sharp on the terminal text, a third the size. */
async function webCut(master) {
    const out = path.join(DOCS, 'muxr-demo.mp4');
    await exec('ffmpeg', [
        '-y', '-v', 'error', '-i', master,
        '-vf', 'scale=1280:-2:flags=lanczos',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '24',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-an',
        out,
    ], { maxBuffer: 1 << 26 });
    console.log(`--> ${path.relative(repo, out)} (${await sizeOf(out)})`);
}

/**
 * GitHub will not play a repo-hosted mp4 inline, so the README needs a real
 * animation. Animated WebP is a fraction of the equivalent GIF at this palette
 * depth, and GitHub renders it.
 */
async function animatedWebp(master) {
    const out = path.join(DOCS, 'muxr-loop.webp');
    await exec('ffmpeg', [
        '-y', '-v', 'error', '-i', master,
        '-vf', 'fps=16,scale=960:-2:flags=lanczos',
        '-loop', '0', '-q:v', '62', '-compression_level', '6',
        out,
    ], { maxBuffer: 1 << 26 });
    console.log(`--> ${path.relative(repo, out)} (${await sizeOf(out)})`);
}

async function main() {
    const only = process.argv.slice(2).filter((id) => id in TARGETS);
    const ids = only.length ? only : ['Reel', 'ReelLoop'];
    await mkdir(DOCS, { recursive: true });
    await mkdir(RAW, { recursive: true });
    for (const id of ids) {
        const master = await render(id);
        if (id === 'Reel') await webCut(master);
        if (id === 'ReelLoop') await animatedWebp(master);
    }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
