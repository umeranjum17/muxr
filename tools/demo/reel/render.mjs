#!/usr/bin/env node
// Renders the film.
//
//   node reel/render.mjs               the whole master
//   node reel/render.mjs 120 480 900   stills of those frames, for review
//
// Bundles once, renders with the composition's own duration, and writes the
// ignored master consumed by the delivery script.
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const bundled = await bundle({
    entryPoint: path.join(here, 'src/index.ts'),
    publicDir: path.join(here, 'public'),
});
const composition = await selectComposition({ serveUrl: bundled, id: 'film' });

const stills = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
if (stills.length > 0) {
    await mkdir(path.join(root, 'review/stills'), { recursive: true });
    for (const frame of stills) {
        const output = path.join(root, 'review/stills', `f${String(frame).padStart(4, '0')}.png`);
        await renderStill({ composition, serveUrl: bundled, output, frame });
        console.log(output);
    }
    process.exit(0);
}

await mkdir(path.join(root, 'raw'), { recursive: true });
const codec = 'h264';
await renderMedia({
    composition,
    serveUrl: bundled,
    codec,
    crf: 16,
    outputLocation: path.join(root, 'raw/muxr-demo-1080.mp4'),
    onProgress: ({ renderedFrames }) => {
        if (renderedFrames % 300 === 0) console.log(`${renderedFrames}/${composition.durationInFrames}`);
    },
});
console.log(`raw/muxr-demo-1080.mp4 — ${composition.durationInFrames} frames @ ${composition.fps}fps`);
