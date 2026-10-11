#!/usr/bin/env node
// Real app screens for the landing's feature rows and the "Everything else in
// your pocket" grid: each a crop of one capture, never a mock-up.
//
//   node scripts/crop-screens.mjs --captures <dir> [--captures <dir>…]
//
// Captures come from current-main emulator runs and the muxr README's own
// screens (docs/assets/readme). Outputs are recorded under `screens` in
// marketing.lock.json, which `marketing:check` verifies and `marketing:sync`
// carries over untouched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const LOCK = join(ROOT, 'marketing.lock.json');
const OUT = 'docs/screens';
const DIRS = process.argv.flatMap((value, at) => (process.argv[at - 1] === '--captures' ? [resolve(value)] : []));
if (DIRS.length === 0) throw new Error('usage: crop-screens.mjs --captures <dir> [--captures <dir>]');
const capture = (name) => {
    const found = DIRS.map((dir) => join(dir, name)).find((file) => existsSync(file));
    if (found === undefined) throw new Error(`no ${name} in ${DIRS.join(', ')}`);
    return found;
};

/** name, capture file, and the crop (w, h, x, y) it is about; no crop keeps the whole screen. */
const SCREENS = [
    ['review', 'changes.jpg'],
    ['lock-screen', 'notification-lock-screen.png', [1080, 810, 0, 130]],
    ['voice', 'voice.jpg', [540, 405, 0, 400]],
    ['dictation', 'dictation.jpg', [540, 405, 0, 760]],
    ['live', 'home-needs-you.png', [1080, 810, 0, 290]],
    ['usage', 'usage.png', [1080, 810, 0, 450]],
    ['tabs', 'tabs.jpg', [540, 405, 0, 40]],
    ['keys', 'terminal-key-row-keyboard.png', [1080, 810, 0, 1040]],
    ['gestures', 'settings-gestures.png', [1080, 810, 0, 300]],
    ['appearance', 'settings-appearance.png', [1080, 810, 0, 250]],
];

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

rmSync(join(ROOT, OUT), { recursive: true, force: true });
mkdirSync(join(ROOT, OUT), { recursive: true });
const inputs = new Map();
const outputs = [];
for (const [name, file, crop] of SCREENS) {
    const src = capture(file);
    inputs.set(file, sha256(src));
    // Crops show at about 320 px wide, so 640 keeps them sharp at 2x.
    const filter = crop === undefined ? 'scale=540:-2:flags=lanczos' : `crop=${crop.join(':')},scale='min(640,iw)':-2:flags=lanczos`;
    ff(['-i', src, '-vf', filter, '-c:v', 'libwebp', '-quality', '82', join(ROOT, OUT, `${name}.webp`)]);
    outputs.push(`${OUT}/${name}.webp`);
}

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
lock.screens = {
    source: 'current-main app captures and the muxr README screens',
    inputs: [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => ({ file, sha256: hash })),
    outputs: outputs.sort().map((file) => ({ file, sha256: sha256(join(ROOT, file)) })),
};
writeFileSync(LOCK, `${JSON.stringify(lock, null, 4)}\n`);
process.stdout.write(`cropped ${outputs.length} screens into ${OUT}\n`);
