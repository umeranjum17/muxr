#!/usr/bin/env node
// Renders the film's caption cards: one authored line, full frame, on ink.
//
//   node cut/cards.mjs
//
// The first cut of this film had no narration at all and the owner watched it
// cold: "randomly doing random things, makes zero sense." The footage is real
// and the story is true, but raw UI cannot narrate itself. These cards are the
// film's grammar now — a short line states what the next shot proves, the shot
// proves it. Apple's structure, the product's own type.
//
// Reads CARDS from lib/film.mjs so the table stays the one source of truth.
import { chromium } from 'playwright';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARDS, FPS } from '../lib/film.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '../..');

const face = async (file) =>
    `data:font/ttf;base64,${(await readFile(path.join(repo, 'apps/mobile/sources/assets/fonts', file))).toString('base64')}`;
const SANS = await face('IBMPlexSans-SemiBold.ttf');

/**
 * One card frame. The line rises four pixels as it fades in and settles a
 * couple of frames before the cut, so every card breathes the same way the
 * held shots do. Nothing else is on screen — the ink and the line.
 */
const page = (text, frame, frames) => {
    const inT = Math.min(1, frame / 9);
    const outT = Math.min(1, Math.max(0, (frames - 1 - frame) / 7));
    const easeOut = (t) => 1 - (1 - t) ** 3;
    const alpha = Math.min(easeOut(inT), easeOut(outT));
    const rise = (4 * (1 - easeOut(inT))).toFixed(2);
    return `<!doctype html><meta charset="utf-8"><style>
        @font-face { font-family: Plex; font-weight: 600; src: url('${SANS}') format('truetype'); }
        * { margin: 0; padding: 0; }
        html, body { width: 1920px; height: 1080px; background: #0a0a0b; overflow: hidden; }
        body { display: flex; align-items: center; justify-content: center; }
        .line { font-family: Plex, sans-serif; font-weight: 600; font-size: 76px;
                letter-spacing: -1px; color: #ececec;
                opacity: ${alpha.toFixed(3)}; transform: translateY(${rise}px); }
    </style><div class="line">${text}</div>`;
};

const dir = await mkdtemp(path.join(tmpdir(), 'cards-'));
try {
    const browser = await chromium.launch();
    const tab = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    for (const card of CARDS) {
        for (let frame = 0; frame < card.frames; frame += 1) {
            await tab.setContent(page(card.text, frame, card.frames));
            if (frame === 0) await tab.waitForTimeout(400);
            await tab.screenshot({ path: path.join(dir, `${String(frame).padStart(3, '0')}.png`) });
        }
        await exec('ffmpeg', ['-v', 'error', '-framerate', String(FPS),
            '-i', path.join(dir, '%03d.png'), '-frames:v', String(card.frames),
            '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-pix_fmt', 'yuv420p',
            '-y', path.join(root, 'cut/shots', `${card.id}.mp4`)]);
        console.log(`cut/shots/${card.id}.mp4 — ${card.frames} frames  "${card.text}"`);
    }
    await browser.close();
} finally {
    await rm(dir, { recursive: true, force: true });
}
