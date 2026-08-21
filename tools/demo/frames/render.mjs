#!/usr/bin/env node
// Renders the store artwork with Chromium: real device stills laid into a
// branded frame, plus the two text-only graphics. Marketing art as CSS, so the
// next person can edit it instead of reopening a design file.
//
// Usage: node frames/render.mjs [--out <dir>] [sceneId ...]
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { reel, scenes } from '../lib/scenes.mjs';
import { fonts, glyph, wordmark } from '../lib/brand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..', '..');
const RAW = path.join(root, 'raw');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx === -1
    ? path.join(repo, 'docs/play/store-assets')
    : path.resolve(args[outIdx + 1]);
const only = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);

const abs = (p) => pathToFileURL(path.join(repo, p)).href;

function fill(template, data) {
    return template
        .replace('__FONT_DISPLAY__', abs(fonts.display))
        .replace('__FONT_SANS__', abs(fonts.sans))
        .replace('__FONT_SANS_SEMI__', abs(fonts.sansSemi))
        .replace('__FONT_MONO__', abs(fonts.mono))
        .replace('__DATA__', JSON.stringify(data));
}

async function shoot(page, name, html, width, height, file) {
    // Chromium will not load a font from file:// unless the page itself is a
    // file, so these have to hit the disk. Keep them in the ignored raw dir.
    const tmp = path.join(RAW, `.${name}.html`);
    await writeFile(tmp, html);
    await page.setViewportSize({ width, height });
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.title === 'ready');
    await page.screenshot({ path: file, type: 'png' });
    await rm(tmp, { force: true });
    console.log(`--> ${path.relative(repo, file)}`);
}

async function main() {
    const frameTemplate = await readFile(path.join(here, 'frame.html'), 'utf8');
    const brandTemplate = await readFile(path.join(here, 'brand.html'), 'utf8');
    const storeScenes = scenes.filter((s) => s.store);
    const chosen = only.length ? storeScenes.filter((s) => only.includes(s.id)) : storeScenes;
    await mkdir(OUT, { recursive: true });
    await mkdir(RAW, { recursive: true });

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });

    let n = 0;
    for (const scene of chosen) {
        const shot = path.join(RAW, `${scene.id}.png`);
        await access(shot).catch(() => {
            throw new Error(`missing capture ${shot} — run \`node build.mjs capture\` first`);
        });
        n += 1;
        const html = fill(frameTemplate, {
            width: 1080,
            height: 1920,
            caption: scene.caption,
            sub: scene.sub ?? '',
            shot: pathToFileURL(shot).href,
            // Show the whole screen by default; the composer is part of the story.
            arWidth: 1080,
            arHeight: scene.cropTo ?? 2400,
            capHeight: scene.capHeight ?? 340,
            badge: scene.badge ?? '',
            glyph: abs(glyph),
        });
        await shoot(page, `frame-${scene.id}`, html, 1080, 1920,
            path.join(OUT, `${String(n).padStart(2, '0')}-${scene.id}.png`));
    }

    // Text-only by requirement: Play rejects device imagery in the feature
    // graphic, and CSS type stays crisp where a generated image would not.
    const graphics = [
        {
            name: 'feature-graphic',
            width: 1024, height: 500, scale: 1,
            line: reel.tagline,
            foot: 'Open source · self-hosted · end-to-end encrypted',
            out: path.join(OUT, 'feature-graphic.png'),
        },
        {
            name: 'social-preview',
            width: 1280, height: 640, scale: 1.22,
            line: reel.tagline,
            foot: 'trymuxr.com · npm i -g @trymuxr/cli',
            out: path.join(repo, 'docs/art/social-preview.png'),
        },
    ];
    for (const g of graphics) {
        const html = fill(brandTemplate, {
            width: g.width,
            height: g.height,
            scale: g.scale,
            line: g.line,
            foot: g.foot,
            wordmark: abs(wordmark),
        });
        await shoot(page, g.name, html, g.width, g.height, g.out);
    }

    await browser.close();
    console.log(`\nrendered ${n} store frame(s) + ${graphics.length} graphic(s) into ${path.relative(repo, OUT)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
