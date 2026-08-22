#!/usr/bin/env node
// Builds the review contact sheet: each shot's frame beside its storyboard panel.
//
//   node review/sheet.mjs
//
// The point is comparison, not decoration. A shot that drifted from what was
// boarded is obvious when the two sit side by side and invisible when they are
// described in prose.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, FPS } from '../lib/film.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'review');

const exists = (file) => access(file).then(() => true, () => false);

/** One frame per shot, taken from the middle where the shot has arrived. */
for (const shot of SHOTS) {
    const clip = path.join(root, 'cut/shots', `${shot.id}.mp4`);
    if (!(await exists(clip))) continue;
    await exec('ffmpeg', ['-v', 'error', '-ss', String(shot.frames / 2 / FPS), '-i', clip,
        '-frames:v', '1', '-y', path.join(OUT, `${shot.id}.png`)]);
}

const cells = [];
for (const shot of SHOTS) {
    const frame = path.join(OUT, `${shot.id}.png`);
    if (await exists(frame)) cells.push({ shot, frame });
}
if (cells.length === 0) {
    console.error('no shots cut yet');
    process.exit(1);
}

// Three across, scaled down: the sheet is for judging framing and continuity,
// so it wants every shot on one screen rather than any one of them large.
const W = 620;
const H = Math.round(W * 9 / 16);
// Forced to an exact cell, not scaled by aspect: one shot a few pixels taller
// than the rest slides every row below it and the sheet stops being readable
// as a grid, which is the only thing it is for.
const inputs = cells.flatMap(({ frame }) => ['-i', frame]);
const scale = cells.map((_, i) =>
    `[${i}:v]scale=${W}:${H},pad=${W}:${H + 30}:0:0:0x141416[c${i}]`).join(';');
const rows = [];
for (let i = 0; i < cells.length; i += 3) {
    const row = cells.slice(i, i + 3).map((_, j) => `[c${i + j}]`).join('');
    const count = Math.min(3, cells.length - i);
    rows.push(`${row}hstack=${count}${count < 3 ? `,pad=${W * 3}:ih:0:0:0x141416` : ''}[r${i / 3}]`);
}
const stack = `${rows.map((_, i) => `[r${i}]`).join('')}vstack=${rows.length}`;
const filter = [scale, ...rows, stack].join(';');

await mkdir(OUT, { recursive: true });
await exec('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', filter,
    '-frames:v', '1', '-y', path.join(OUT, 'sheet.png')], { maxBuffer: 1 << 28 });

console.log(`review/sheet.png — ${cells.length} of ${SHOTS.length} shots`);
for (const { shot } of cells) {
    console.log(`  ${shot.id} ${shot.name.padEnd(28)} ${(shot.start / FPS).toFixed(1)}-${((shot.start + shot.frames) / FPS).toFixed(1)}s`);
}
