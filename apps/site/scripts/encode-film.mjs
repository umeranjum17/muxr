#!/usr/bin/env node
// Web cuts of the "Tales from the Herd" films for the landing page.
//
//   node scripts/encode-film.mjs --source <finals dir> [--source <finals dir>…] --captures <current-main captures dir>
//
// Every output is silent, loop-cut (title and end cards trimmed), and paired
// with a poster. The 16:9 cut serves every width. Each episode
// also gets its real-app moment: a crop of the capture its story turns on.
// Outputs are recorded under `film` in marketing.lock.json, which
// `marketing:check` verifies and `marketing:sync` carries over untouched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const LOCK = join(ROOT, 'marketing.lock.json');
const OUT = 'docs/film';
const args = (flag) => process.argv.flatMap((value, at) => (process.argv[at - 1] === flag ? [resolve(value)] : []));
const SOURCES = args('--source');
const [CAPTURES] = args('--captures');
if (SOURCES.length === 0 || CAPTURES === undefined) throw new Error('usage: encode-film.mjs --source <dir> [--source <dir>] --captures <dir>');
const final = (name) => {
    const found = SOURCES.map((dir) => join(dir, name)).find((file) => existsSync(file));
    if (found === undefined) throw new Error(`no ${name} in ${SOURCES.join(', ')}`);
    return found;
};

/** name, final file stem, cut [from, to] seconds, poster second, and optional
 *  [AV1, H.264] CRF for a film whose motion needs more squeezing to stay small. */
const FILMS = [
    ['gate', 'muxr-the-gate', 0, 29.2, 8.4],
    // No. 1 again, from the train: the answer, not the gate.
    ['gate-answer', 'muxr-the-gate', 12.4, 28.6, 25],
    ['good-morning', 'muxr-ep2-good-morning', 1.5, 18.8, 6],
    ['shearing', 'muxr-ep3-the-shearing', 1.5, 18.9, 5],
    ['line-up', 'muxr-ep4-the-line-up', 1.5, 20.1, 12.2],
    ['farmhouse', 'muxr-ep5-the-farmhouse-window', 1.5, 24.1, 20.4],
    // Twenty fields of moving sheep: the busiest frames in the series.
    ['whole-farm', 'muxr-ep6-the-whole-farm', 1.5, 23.8, 3.6, [50, 34]],
    ['talk-to-the-herd', 'muxr-ep7-talk-to-the-herd', 1.5, 24.3, 4.5],
];
/** Each episode's real-app moment: capture file and the crop (w, h, x, y) it turns on. */
const MOMENTS = [
    ['gate', 'needs-you-terminal.png', [1000, 800, 0, 1220]],
    ['good-morning', 'home-ready.png', [1020, 700, 30, 1175]],
    // The commands sheet is the film's own capture of main e14e774b; current main has none.
    ['shearing', 'commands-sheet.jpg', [540, 480, 0, 530]],
    ['line-up', 'swipe-mid.png', [1080, 810, 0, 90]],
    ['farmhouse', 'farmhouse-4-computer-signed-in.png', [720, 540, 60, 470]],
    ['whole-farm', 'spaces.png', [1020, 765, 30, 1250]],
    // The same README voice capture as the pocket grid's old voice tile.
    ['talk-to-the-herd', 'voice.jpg', [540, 405, 0, 400]],
];

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const sha256 = (file) => createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex');

rmSync(join(ROOT, OUT), { recursive: true, force: true });
mkdirSync(join(ROOT, OUT), { recursive: true });
const outputs = [];
const inputs = new Set();

for (const [name, stem, from, to, poster, [av1, h264] = [44, 30]] of FILMS) {
    for (const [shape, width] of [['16x9', 1280]]) {
        const src = final(`${stem}-${shape}.mp4`);
        inputs.add(src);
        const base = join(ROOT, OUT, `${name}-${shape}`);
        const cut = ['-ss', String(from), '-t', String(to - from), '-i', src, '-an', '-vf', `scale=${width}:-2:flags=lanczos`];
        ff([...cut, '-c:v', 'libsvtav1', '-crf', String(av1), '-preset', '5', '-pix_fmt', 'yuv420p', `${base}.webm`]);
        ff([...cut, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(h264), '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${base}.mp4`]);
        ff(['-ss', String(poster), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=lanczos`, '-c:v', 'libwebp', '-quality', '80', `${base}.webp`]);
        outputs.push(...['webm', 'mp4', 'webp'].map((ext) => `${OUT}/${name}-${shape}.${ext}`));
        // Link previews still want a JPEG.
        if (name === 'gate' && shape === '16x9') {
            ff(['-ss', String(poster), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=lanczos`, '-q:v', '3', `${base}.jpg`]);
            outputs.push(`${OUT}/${name}-${shape}.jpg`);
        }
    }
}

for (const [name, capture, [w, h, x, y]] of MOMENTS) {
    const src = join(CAPTURES, capture);
    inputs.add(src);
    ff(['-i', src, '-vf', `crop=${w}:${h}:${x}:${y},scale='min(720,iw)':-2:flags=lanczos`, '-c:v', 'libwebp', '-quality', '84', join(ROOT, OUT, `screen-${name}.webp`)]);
    outputs.push(`${OUT}/screen-${name}.webp`);
}

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
lock.film = {
    source: 'Tales from the Herd finals and current-main app captures',
    inputs: [...inputs].sort().map((file) => ({ file: file.slice(file.lastIndexOf('/') + 1), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })),
    outputs: outputs.sort().map((file) => ({ file, sha256: sha256(file) })),
};
writeFileSync(LOCK, `${JSON.stringify(lock, null, 4)}\n`);
process.stdout.write(`encoded ${outputs.length} film files into ${OUT}\n`);
