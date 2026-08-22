#!/usr/bin/env node
// One entry point for the whole pipeline:
//
//   take      run the job once, recording the desk and the phone together
//   shots     cut shots 01-10 out of that take
//   lockup    render shot 11, the only authored frame in the film
//   assemble  join them into the master, the 720p cut and the README loop
//   sheet     one frame per shot, side by side, for reviewing the whole thing
//   leakcheck read every shipped frame and fail on anything private
//   frames    lay the settled stills into branded Play Store frames
//
// Usage: node build.mjs [take|shots|lockup|assemble|sheet|leakcheck|frames ...]
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
    cards: () => run('node', ['cut/cards.mjs']),
    shots: () => run('node', ['cut/shots.mjs']),
    lockup: () => run('node', ['cut/lockup.mjs']),
    assemble: () => run('node', ['cut/assemble.mjs']),
    sheet: () => run('node', ['review/sheet.mjs']),
    leakcheck: () => run('node', ['review/leakcheck.mjs', 'raw/muxr-demo-1080.mp4']),
    frames: () => run('node', ['frames/render.mjs']),
};

async function main() {
    const asked = process.argv.slice(2).filter((s) => s in STEPS);
    // `take` needs a phone in front of you, so it is never part of the default
    // run: the default is a recut of whatever is already in `raw/take`.
    const order = asked.length ? asked
        : ['cards', 'shots', 'lockup', 'assemble', 'sheet', 'leakcheck'];
    for (const step of order) {
        console.log(`\n### ${step}`);
        await STEPS[step]();
    }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
