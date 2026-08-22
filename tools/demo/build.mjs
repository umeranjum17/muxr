#!/usr/bin/env node
// One entry point for the whole pipeline:
//
//   take      run the job once, recording the desk and the phone together
//   reel      render the composition (Remotion) into the 1080p60 master
//   deliver   faststart the shipped mp4 and cut the README loop from it
//   leakcheck read every shipped frame and fail on anything private
//   frames    lay the settled stills into branded Play Store frames
//
// Usage: node build.mjs [take|reel|deliver|leakcheck|frames ...]
//
// `take` is the only step that needs a phone and a live agent. Everything after
// it works off `raw/take`, so a recut is cheap and does not need the shoot set
// up again.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', cwd: here });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}`))));
    });
}

const STEPS = {
    take: () => run('node', ['capture/take.mjs']),
    reel: () => run('node', ['reel/render.mjs']),
    deliver: () => run('node', ['reel/deliver.mjs']),
    leakcheck: () => run('node', ['review/leakcheck.mjs', 'raw/muxr-demo-1080.mp4']),
    frames: () => run('node', ['frames/render.mjs']),
};

async function main() {
    const asked = process.argv.slice(2).filter((s) => s in STEPS);
    // `take` needs a phone in front of you, so it is never part of the default
    // run: the default is a recut of whatever is already in `raw/take`.
    const order = asked.length ? asked
        : ['reel', 'deliver', 'leakcheck'];
    for (const step of order) {
        console.log(`\n### ${step}`);
        await STEPS[step]();
    }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
