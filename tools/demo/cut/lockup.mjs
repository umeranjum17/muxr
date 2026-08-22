#!/usr/bin/env node
// Renders shot 11, the brand close.
//
//   node cut/lockup.mjs
//
// The only authored frame in the film. Everything else is the product's own
// output, so this is deliberately plain: the wordmark, one line typed with a
// cursor, one URL. No install command — the URL is the single call to action.
//
// Rendered frame by frame through a headless browser rather than a video tool
// so the type is the product's own IBM Plex Mono at exact sizes, and so the
// cursor blink is derived from the frame number and comes out identical on
// every run.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '../..');

// `setContent` has no base URL, so a `file://` @font-face silently falls back
// to a system serif. Embedding the faces is the only reliable way to get the
// product's own type into the render.
const face = async (file) =>
    `data:font/ttf;base64,${(await readFile(path.join(repo, 'apps/mobile/sources/assets/fonts', file))).toString('base64')}`;
const MONO = await face('IBMPlexMono-Regular.ttf');
const SANS = await face('IBMPlexSans-SemiBold.ttf');

const FRAMES = 90;
const LINE = 'Leave the desk. Not the work.';
/** Typing runs frames 20-56; the URL lands at 64; everything holds after 74. */
const TYPE_FROM = 20;
const TYPE_TO = 56;
const URL_AT = 64;

const page = (frame) => {
    const typed = frame <= TYPE_FROM ? 0
        : Math.min(LINE.length, Math.round(((frame - TYPE_FROM) / (TYPE_TO - TYPE_FROM)) * LINE.length));
    // Frame-derived, so the blink is the same on every render.
    const cursor = Math.floor(frame / 15) % 2 === 0 ? 1 : 0;
    const mark = Math.min(1, Math.max(0, (frame - 4) / 14));
    const url = Math.min(1, Math.max(0, (frame - URL_AT) / 12));
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    return `<!doctype html><meta charset="utf-8"><style>
        @font-face { font-family: PlexMono; src: url('${MONO}') format('truetype'); }
        @font-face { font-family: Plex; font-weight: 600; src: url('${SANS}') format('truetype'); }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 1920px; height: 1080px; background: #0a0a0b; overflow: hidden; }
        body { display: flex; flex-direction: column; align-items: center; justify-content: center; }
        /* Sized against the terminal shots rather than against the page: the
           film has to hold at 390px, where 30px type lands at six pixels and
           the only legible thing on screen would be the wordmark. */
        .mark { font-family: PlexMono; font-size: 132px; color: #ececec; letter-spacing: -4px;
                opacity: ${ease(mark)}; }
        .line { font-family: PlexMono; font-size: 56px; color: #ececec; margin-top: 56px; }
        .cur  { opacity: ${cursor}; }
        .url  { font-family: Plex; font-weight: 600; font-size: 52px; color: #ececec; margin-top: 104px;
                opacity: ${ease(url)}; }
    </style>
    <div class="mark">muxr</div>
    <div class="line">${LINE.slice(0, typed)}<span class="cur">▊</span></div>
    <div class="url">trymuxr.com</div>`;
};

const dir = await mkdtemp(path.join(tmpdir(), 'lockup-'));
try {
    const browser = await chromium.launch();
    const tab = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    for (let frame = 0; frame < FRAMES; frame += 1) {
        await tab.setContent(page(frame));
        if (frame === 0) await tab.waitForTimeout(600);
        await tab.screenshot({ path: path.join(dir, `${String(frame).padStart(3, '0')}.png`) });
    }
    await browser.close();

    await exec('ffmpeg', ['-v', 'error', '-framerate', '30', '-i', path.join(dir, '%03d.png'),
        '-frames:v', String(FRAMES), '-c:v', 'libx264', '-crf', '16', '-preset', 'slow',
        '-pix_fmt', 'yuv420p', '-y', path.join(root, 'cut/shots/11.mp4')]);
    console.log(`cut/shots/11.mp4 — ${FRAMES} frames`);
} finally {
    await rm(dir, { recursive: true, force: true });
}
