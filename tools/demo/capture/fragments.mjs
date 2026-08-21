#!/usr/bin/env node
// Cuts the film's raw material out of the captures.
//
// The film does not put the app in a phone bezel. It floats pieces of the real
// UI in space at different depths, and lets the product's own pills be the
// motion vocabulary. That needs fragments, not whole screens — declared here so
// a recapture reproduces them exactly rather than being re-cropped by hand.
//
// Usage: node capture/fragments.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const RAW = path.join(root, 'raw');
const OUT = path.join(root, 'reel', 'public', 'frag');

/** [x, y, w, h] in the 1080x2400 capture. */
const CROPS = [
    { id: 'spaces', from: 'herd', theme: 'dark', rect: [30, 1130, 1020, 920] },
    { id: 'spaces-light', from: 'herd', theme: 'light', rect: [30, 1130, 1020, 920] },
    { id: 'live', from: 'herd', theme: 'dark', rect: [28, 395, 1024, 510] },
    { id: 'composer', from: 'terminal', theme: 'dark', rect: [28, 2202, 1024, 128] },
    { id: 'keys', from: 'terminal', theme: 'dark', rect: [28, 2048, 1024, 122] },
    { id: 'termbody', from: 'terminal', theme: 'dark', rect: [18, 330, 1044, 1640] },
    { id: 'diff', from: 'changes', theme: 'light', rect: [28, 760, 1024, 900] },
    { id: 'difftabs', from: 'changes', theme: 'light', rect: [28, 626, 1010, 122] },
    { id: 'tree', from: 'files', theme: 'light', rect: [28, 370, 1024, 1080] },
    { id: 'spend', from: 'usage', theme: 'dark', rect: [28, 352, 1024, 620] },
    { id: 'plugrows', from: 'plugins', theme: 'dark', rect: [28, 560, 1024, 1080] },
    { id: 'inboxrows', from: 'inbox', theme: 'dark', rect: [28, 250, 1024, 920] },
    { id: 'orb', from: 'voice', theme: 'dark', rect: [150, 380, 780, 780] },
    { id: 'conn', from: 'connection', theme: 'dark', rect: [28, 240, 1024, 920] },
];

/**
 * The nav chips are the film's pill vocabulary, so each one has to come out as
 * its own object. Their row sits on a flat ground, so the boundaries can be
 * found rather than guessed — a re-capture that shifts the row still works.
 */
async function cutChips() {
    const src = path.join(RAW, 'dark', 'herd.png');
    const { stdout } = await exec('magick', [
        src, '-crop', '1080x1+0+350', '+repage', '-colorspace', 'gray', '-depth', '8', 'txt:-',
    ], { maxBuffer: 1 << 24 });

    const value = new Map();
    for (const line of stdout.split('\n').slice(1)) {
        const [coord, rest] = line.split(':');
        if (rest === undefined) continue;
        value.set(Number(coord.split(',')[0]), Number.parseInt(rest.split('#')[1].slice(0, 2), 16));
    }
    const ground = Math.min(...value.values());

    const runs = [];
    let start = null;
    for (let x = 0; x < 1080; x += 1) {
        const lit = (value.get(x) ?? 0) > ground + 4;
        if (lit && start === null) start = x;
        if (!lit && start !== null) {
            if (x - start > 60) runs.push([start, x - start]);
            start = null;
        }
    }

    const names = ['machine', 'usage', 'files', 'runbook', 'inbox', 'ports'];
    for (const [index, [x, w]] of runs.entries()) {
        const name = names[index];
        if (name === undefined) break;
        await exec('magick', [src, '-crop', `${w}x92+${x}+306`, '+repage', path.join(OUT, `chip-${name}.png`)]);
        console.log(`--> frag/chip-${name}.png  ${w}x92`);
    }
}

async function main() {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    for (const crop of CROPS) {
        const [x, y, w, h] = crop.rect;
        await exec('magick', [
            path.join(RAW, crop.theme, `${crop.from}.png`),
            '-crop', `${w}x${h}+${x}+${y}`, '+repage',
            path.join(OUT, `${crop.id}.png`),
        ]);
        console.log(`--> frag/${crop.id}.png  ${w}x${h}  (${crop.theme}/${crop.from})`);
    }
    await cutChips();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
