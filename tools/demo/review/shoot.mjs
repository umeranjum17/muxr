#!/usr/bin/env node
// Renders every frame the review loop scores, in one command.
//
//   node review/shoot.mjs          everything
//   node review/shoot.mjs film     just the film key frames
//   node review/shoot.mjs store    just the store frames
//
// Output lands in review/frames/ as film-<id>.png and store-<id>.png. The ids
// come straight out of reel/src/beats.ts so this file cannot drift from it.
//
// This bundles once and drives @remotion/renderer directly. Shelling out to
// `remotion still` per frame re-bundles and relaunches a browser every time,
// which took eleven minutes for nineteen frames — long enough that the review
// loop around it stopped being usable.
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const REEL = path.join(root, 'reel');
const OUT = path.join(here, 'frames');

async function ids(constName) {
    const src = await readFile(path.join(REEL, 'src/beats.ts'), 'utf8');
    const block = src.slice(src.indexOf(`export const ${constName}`));
    return [...block.slice(0, block.indexOf('\n];')).matchAll(/^\s*(?:\{\s*)?id: '([^']+)'/gm)].map((m) => m[1]);
}

const only = process.argv[2];
await mkdir(OUT, { recursive: true });

const t0 = Date.now();
const serveUrl = await bundle({
    entryPoint: path.join(REEL, 'src/index.ts'),
    publicDir: path.join(REEL, 'public'),
    onProgress: () => {},
});
console.log(`bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const jobs = [];
if (only !== 'store') {
    for (const beat of await ids('BEATS')) jobs.push(['FilmFrame', `film-${beat}`, { beat }]);
}
if (only !== 'film') {
    for (const shot of await ids('STORE')) jobs.push(['StoreFrame', `store-${shot}`, { shot }]);
}

for (const [id, name, props] of jobs) {
    const composition = await selectComposition({ serveUrl, id, inputProps: props });
    await renderStill({
        composition,
        serveUrl,
        output: path.join(OUT, `${name}.png`),
        inputProps: props,
        imageFormat: 'png',
        chromiumOptions: { gl: 'angle' },
    });
    console.log(`  ${name}.png`);
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
