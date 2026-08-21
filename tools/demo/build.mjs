#!/usr/bin/env node
// One entry point for the whole pipeline:
//
//   stage    copy the app's own fonts and marks into the Remotion public dir
//   capture  drive the real app with Maestro while adb records the screen
//   cut      trim each recording to its shot and speed it to one slot
//   frames   lay the settled stills into branded Play Store frames
//   reel     render the demo video and the README loop
//
// Usage: node build.mjs [stage|capture|cut|frames|reel ...]   (default: all)
import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const FONTS = [
    'BricolageGrotesque-Bold',
    'IBMPlexSans-Regular',
    'IBMPlexSans-SemiBold',
    'IBMPlexMono-Regular',
];
const MARKS = ['glyph@3x.png', 'wordmark@3x.png'];

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', cwd: here });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}`))));
    });
}

// The reel draws with the product's own type and marks. Copy rather than
// vendor: a second set of font files in the repo is a second set to drift.
async function stage() {
    const pub = path.join(here, 'reel', 'public');
    await mkdir(path.join(pub, 'fonts'), { recursive: true });
    await mkdir(path.join(pub, 'img'), { recursive: true });
    await mkdir(path.join(pub, 'shots'), { recursive: true });
    for (const name of FONTS) {
        await copyFile(
            path.join(repo, 'apps/mobile/sources/assets/fonts', `${name}.ttf`),
            path.join(pub, 'fonts', `${name}.ttf`),
        );
    }
    for (const name of MARKS) {
        await copyFile(
            path.join(repo, 'apps/mobile/sources/assets/images', name),
            path.join(pub, 'img', name),
        );
    }
    console.log(`staged ${FONTS.length} fonts and ${MARKS.length} marks into reel/public`);
}

const STEPS = {
    stage,
    capture: () => run('node', ['capture/capture.mjs']),
    cut: () => run('node', ['cut/cut.mjs']),
    frames: () => run('node', ['frames/render.mjs']),
    reel: () => run('node', ['reel/render.mjs']),
};

async function main() {
    const asked = process.argv.slice(2).filter((s) => s in STEPS);
    const order = asked.length ? asked : Object.keys(STEPS);
    for (const step of order) {
        console.log(`\n### ${step}`);
        await STEPS[step]();
    }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
