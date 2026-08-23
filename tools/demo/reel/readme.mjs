#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '../..');
const raw = path.join(root, 'raw/readme');
const features = path.join(repo, 'docs/assets/readme');
const clips = [
    { id: 'readme-unblock', name: 'unblock', poster: 120 },
    { id: 'readme-changes', name: 'changes', poster: 120 },
    { id: 'readme-voice', name: 'voice', poster: 100 },
    { id: 'readme-self-host', name: 'self-host', poster: 100 },
];

await mkdir(raw, { recursive: true });
await mkdir(features, { recursive: true });
const bundled = await bundle({
    entryPoint: path.join(here, 'src/index.ts'),
    publicDir: path.join(here, 'public'),
});

const render = async (id, name) => {
    const composition = await selectComposition({ serveUrl: bundled, id });
    const mp4 = path.join(raw, `${name}.mp4`);
    await renderMedia({ composition, serveUrl: bundled, codec: 'h264', crf: 18, scale: 0.5, outputLocation: mp4 });
    return { composition, mp4 };
};

for (const clip of clips) {
    const { composition, mp4 } = await render(clip.id, clip.name);
    await renderStill({
        composition,
        serveUrl: bundled,
        frame: clip.poster,
        scale: 0.5,
        imageFormat: 'jpeg',
        jpegQuality: 90,
        output: path.join(features, `${clip.name}.jpg`),
    });
    await exec('ffmpeg', ['-v', 'error', '-i', mp4, '-vf', 'fps=12',
        '-c:v', 'libwebp', '-lossless', '0', '-compression_level', '6', '-q:v', '54',
        '-loop', '0', '-an', '-y', path.join(features, `${clip.name}.webp`)]);
    await rm(mp4);
    console.log(`${clip.id} -> docs/assets/readme/${clip.name}.{webp,jpg}`);
}

const { mp4: hero } = await render('readme-hero', 'muxr-loop');
const wordmark = path.join(repo, 'apps/mobile/sources/assets/images/wordmark@3x.png');
await exec('ffmpeg', ['-v', 'error', '-i', hero, '-loop', '1', '-i', wordmark,
    '-filter_complex', '[0:v]fps=24[base];[1:v]scale=180:-1:flags=neighbor[mark];[base][mark]overlay=W-w-20:H-h-16',
    '-t', '9', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '82', '-loop', '0', '-an', '-y',
    path.join(repo, 'docs/demo/muxr-loop.webp')]);
await rm(hero);
console.log('readme-hero -> docs/demo/muxr-loop.webp');
