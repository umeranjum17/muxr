#!/usr/bin/env node
// Prints when things happened in a take, so shots can be pointed at them.
//
//   node cut/timeline.mjs
//
// Every in-point in `cut/shots.mjs` is a second of the recording, and every
// reshoot moves all of them. Finding them by extracting candidate frames and
// looking is slow and easy to get subtly wrong — a frame that looks right at
// 45.5s can be a second out, which is thirty frames of the wrong thing.
//
// The desk cast is text, so it can simply be searched. The numbers this prints
// are the ones that go into the recipe table.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const FPS = 30; // the capture's rate — the take is recorded at 30

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cast = path.join(root, 'raw/take/desk.cast');

const frames = (await readFile(cast, 'utf8')).split('\n').slice(1).filter(Boolean)
    .map((line) => JSON.parse(line));

/** Strips the repaint escapes so the text can be matched as text. */
const screen = (frame) => frame[2].replace(/\[[HJ0-9;]*[A-Za-z]/g, '');

const MARKS = [
    ['task on screen', /refresh-token race in/],
    ['reading files', /Reading src\/auth|Read \d+ files/],
    ['the fix written', /this\.invalidate\(refresh\)/],
    ['approval up', /Do you want to proceed/],
    ['answered', null],
    ['second question', /git stash push/],
    ['finished', /passed\./],
];

let approval;
for (const [name, re] of MARKS) {
    if (re === null) continue;
    const first = frames.find((f) => re.test(screen(f)));
    const last = [...frames].reverse().find((f) => re.test(screen(f)));
    if (first === undefined) { console.log(`${name.padEnd(18)} —`); continue; }
    if (name === 'approval up') approval = first[0];
    console.log(`${name.padEnd(18)} ${first[0].toFixed(2).padStart(8)}s`
        + `  frame ${String(Math.round(first[0] * FPS)).padStart(6)}`
        + `  last seen ${last[0].toFixed(2)}s`);
}

// The tap is not a string, it is the moment the question stops being on screen.
if (approval !== undefined) {
    const gone = frames.find((f) => f[0] > approval && !/Do you want to proceed/.test(screen(f)));
    if (gone !== undefined) {
        console.log(`${'answered'.padEnd(18)} ${gone[0].toFixed(2).padStart(8)}s`
            + `  frame ${String(Math.round(gone[0] * FPS)).padStart(6)}`
            + `  after ${(gone[0] - approval).toFixed(1)}s of waiting`);
    }
}
console.log(`${'take length'.padEnd(18)} ${frames[frames.length - 1][0].toFixed(2).padStart(8)}s`
    + `  ${frames.length} polled frames`);
