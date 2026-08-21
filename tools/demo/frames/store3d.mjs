#!/usr/bin/env node
// Renders the Play Store frames in the film's language, one still per scene.
//
// No bezel: the capture floats in the dark with a shallow tilt and a soft
// shadow, the same treatment every fragment in the film gets. The tilt stays
// small because a Play carousel renders these at thumbnail size and the point
// of a store screenshot is that the UI is readable.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scenes } from '../lib/scenes.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..', '..');
const OUT = path.join(repo, 'docs/play/store-assets');
const PUBLIC_DIR = path.join(root, 'reel/public');
const ENTRY = path.join(root, 'reel/src/index.ts');

async function main() {
    const chosen = scenes
        .filter((s) => s.store)
        .sort((a, b) => (a.storeOrder ?? 99) - (b.storeOrder ?? 99));
    await mkdir(OUT, { recursive: true });
    // The stage samples from reel/public, so the settled stills have to be there.
    for (const theme of ['light', 'dark']) {
        await mkdir(path.join(PUBLIC_DIR, 'stills', theme), { recursive: true });
    }
    for (const scene of chosen) {
        const theme = scene.storeTheme ?? 'light';
        await copyFile(
            path.join(root, 'raw', theme, `${scene.id}.png`),
            path.join(PUBLIC_DIR, 'stills', theme, `${scene.id}.png`),
        );
    }

    let n = 0;
    for (const scene of chosen) {
        n += 1;
        const file = path.join(OUT, `${String(n).padStart(2, '0')}-${scene.id}.png`);
        await exec('npx', [
            'remotion', 'still', ENTRY, 'StoreFrame', file,
            `--public-dir=${PUBLIC_DIR}`,
            '--props', JSON.stringify({
                id: scene.id,
                theme: scene.storeTheme ?? 'light',
                caption: scene.caption,
                sub: scene.sub ?? '',
            }),
        ], { cwd: path.join(root, 'reel'), maxBuffer: 1 << 26 });
        console.log(`--> ${path.relative(repo, file)}  (${scene.storeTheme})`);
    }
    console.log(`\nrendered ${n} store frame(s)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
