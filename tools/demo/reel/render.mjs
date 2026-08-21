#!/usr/bin/env node
// Renders the film.
//
//   node reel/render.mjs                 -> raw/muxr-film.mp4 (1920x1080)
//
// `gl: 'angle'` is required, not optional: the grade runs on the GPU through
// @remotion/effects and every frame fails to acquire a WebGL2 context without
// it.
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'raw/muxr-film.mp4');

const serveUrl = await bundle({
    entryPoint: path.join(root, 'reel/src/index.ts'),
    publicDir: path.join(root, 'reel/public'),
    onProgress: () => {},
});
const composition = await selectComposition({ serveUrl, id: 'Reel' });
console.log(`${composition.durationInFrames}f / ${(composition.durationInFrames / composition.fps).toFixed(1)}s`);

let last = -1;
await renderMedia({
    composition, serveUrl, codec: 'h264', outputLocation: out,
    crf: 17, chromiumOptions: { gl: 'angle' }, concurrency: 4,
    onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 100);
        if (pct >= last + 10) { last = pct; console.log(`  ${pct}%`); }
    },
});
console.log(`--> ${path.relative(root, out)}`);
