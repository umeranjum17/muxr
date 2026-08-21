#!/usr/bin/env node
// One still from the middle of every shot, so a broken shot is found in 30
// seconds instead of after a four-minute render.
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const REEL = path.join(root, 'reel');
const OUT = path.join(here, 'reel');
await mkdir(OUT, { recursive: true });

const src = await readFile(path.join(REEL, 'src/film.ts'), 'utf8');
const shots = [...src.matchAll(/id: '([a-z]+)', frames: (\d+)/g)].map((m) => ({ id: m[1], frames: Number(m[2]) }));
let at = 0;
const marks = shots.map((shot) => { const mid = at + Math.floor(shot.frames / 2); at += shot.frames; return { ...shot, mid }; });

const serveUrl = await bundle({ entryPoint: path.join(REEL, 'src/index.ts'), publicDir: path.join(REEL, 'public'), onProgress: () => {} });
const composition = await selectComposition({ serveUrl, id: 'Reel' });
console.log(`Reel: ${composition.durationInFrames}f @ ${composition.fps}fps`);

for (const [i, mark] of marks.entries()) {
    await renderStill({
        composition, serveUrl, frame: mark.mid,
        output: path.join(OUT, `${String(i + 1).padStart(2, '0')}-${mark.id}.png`),
        imageFormat: 'png', chromiumOptions: { gl: 'angle' },
    });
    console.log(`  ${String(i + 1).padStart(2)} ${mark.id.padEnd(10)} f${mark.mid}`);
}
