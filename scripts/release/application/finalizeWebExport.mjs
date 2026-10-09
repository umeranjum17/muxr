#!/usr/bin/env node
/**
 * Finish the web export's index.html.
 *
 * `expo export` with `web.output: "single"` renders its own SPA template
 * and never consults a +html.tsx, so the install metadata the PWA needs
 * (manifest link, Apple web-app meta, touch icon, favicon, the keyboard-resizing
 * viewport) has to be written into the built file. This runs right after
 * the export as part of `web:export`, so every consumer of dist/ -- the
 * self-host deploy, the demo, the diagnostics -- receives the same shell.
 *
 * The same shell carries the web splash: the app's own splash (expo-splash-screen)
 * is a native no-op on web, so without this the installed PWA shows the bare,
 * themed-only body until the JS bundle parses. The splash is CSS and one inline
 * SVG (the muxr mark reused from public/favicon.svg, recoloured with
 * currentColor), shows from the first paint, follows prefers-color-scheme, and
 * is removed structurally -- `#root:not(:empty)` -- the instant React mounts,
 * so it needs no script after render and can never cover the app's own error or
 * offline screen. Adds no scripts, so the CSP (script-src 'self') is untouched.
 *
 * The index.html step is idempotent: a re-run replaces its own blocks and Expo's
 * favicon link, leaving one icon link for the runtime attention switcher to
 * update. The sw.js step consumes its version token, so a re-run needs a fresh
 * export (web:export always runs one). Fails closed:
 * an index.html without the shape it expects (one <head>, one viewport meta, one
 * empty #root) aborts the export rather than shipping a shell that would install
 * without a manifest or launch without a splash.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const indexPath = process.argv[2] ?? join(root, 'apps', 'mobile', 'dist', 'index.html');
const faviconPath = join(root, 'apps', 'mobile', 'public', 'favicon.svg');

export const INSTALL_META = [
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<meta name="apple-mobile-web-app-title" content="muxr">',
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
];
const START = '<!-- muxr:install-meta -->';
const END = '<!-- /muxr:install-meta -->';
export const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, interactive-widget=resizes-content" />';

// The splash: themed background and a centred mark, from first paint until
// React mounts. The light background matches the native iOS splash
// (app.config.js light #F2F2F7); dark matches the native dark splash (#000000).
export const SPLASH_LIGHT_BACKGROUND = '#F2F2F7';
export const SPLASH_DARK_BACKGROUND = '#000000';
const SPLASH_STYLE_START = '<!-- muxr:web-splash-style -->';
const SPLASH_STYLE_END = '<!-- /muxr:web-splash-style -->';
const SPLASH_MARK_START = '<!-- muxr:web-splash-mark -->';
const SPLASH_MARK_END = '<!-- /muxr:web-splash-mark -->';

// The worker carries this token and the export replaces it with the shell hash.
export const SHELL_VERSION_TOKEN = '__MUXR_SHELL_VERSION__';

export function shellVersion(html, worker) {
    return createHash('sha256').update(html).update('\n').update(worker).digest('hex').slice(0, 16);
}

export function finalizeServiceWorker(source, version) {
    if (!source.includes(SHELL_VERSION_TOKEN)) {
        throw new Error('sw.js carries no shell version token; refusing to ship it');
    }
    return source.replaceAll(SHELL_VERSION_TOKEN, version);
}

/**
 * The muxr mark as an inline SVG, reused from the checked-in favicon (the same
 * pixel wordmark the native splash draws -- no new art). The favicon's wordmark
 * is a grid of 22-unit squares; dropping its translate/scale leave the tighter
 * 464x230 box so the mark fills the splash without padding. Recoloured with
 * currentColor so the CSS can flip it dark-on-light / light-on-dark.
 */
export function splashMarkSvg(faviconSource) {
    const group = faviconSource.match(/<g\b[^>]*>([\s\S]*?)<\/g>/);
    const paths = [...(group?.[1] ?? '').matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]);
    if (paths.length === 0) {
        throw new Error('favicon.svg carries no muxr mark; refusing to inline an empty splash');
    }
    let width = 0;
    let height = 0;
    for (const d of paths) {
        const square = /^M(\d+) (\d+)h22v22h-22z$/.exec(d);
        if (square !== null) {
            width = Math.max(width, Number(square[1]) + 22);
            height = Math.max(height, Number(square[2]) + 22);
        }
    }
    const viewBox = width > 0 && height > 0
        ? `0 0 ${width} ${height}`
        : (faviconSource.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 1024 1024');
    const body = paths.map((d) => `<path d="${d}"/>`).join('');
    return `<svg viewBox="${viewBox}" role="img" aria-label="muxr"><g fill="currentColor">${body}</g></svg>`;
}

const SPLASH_STYLE = [
    '<style id="muxr-splash-style">',
    `html,body{background:${SPLASH_LIGHT_BACKGROUND}}`,
    `#muxr-splash{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:${SPLASH_LIGHT_BACKGROUND};color:#111111}`,
    '#muxr-splash svg{width:min(64vw,240px);height:auto;display:block}',
    // The app owns #root; the moment React mounts any child the splash is gone,
    // with no script and nothing to leave covering an error or offline screen.
    '#root:not(:empty)+#muxr-splash{display:none}',
    `@media (prefers-color-scheme:dark){html,body{background:${SPLASH_DARK_BACKGROUND}}#muxr-splash{background:${SPLASH_DARK_BACKGROUND};color:#ffffff}}`,
    '</style>',
].join('\n');

const strip = (text, start, end) => text.replace(new RegExp(`\\s*${start}[\\s\\S]*?${end}\\s*`, 'g'), '');

export function finalizeWebExport(html, faviconSource = readFileSync(faviconPath, 'utf8')) {
    if ((html.match(/<head[\s>]/g) ?? []).length !== 1 || !html.includes('</head>')) {
        throw new Error('index.html has no single <head>; refusing to finalize an unexpected shell');
    }
    const viewports = html.match(/<meta name="viewport"[^>]*>/g) ?? [];
    if (viewports.length !== 1) {
        throw new Error(`index.html has ${viewports.length} viewport metas; expected exactly one`);
    }
    let next = html.replace(viewports[0], VIEWPORT);
    next = next.replace(/<link\b[^>]*rel="icon"[^>]*>/g, '');
    next = strip(next, START, END);
    next = strip(next, SPLASH_STYLE_START, SPLASH_STYLE_END);
    // The body block sits directly before the app's entry scripts, so the re-run
    // must not eat the newline/indent ahead of them: consume only the leading
    // newline this step itself inserts.
    next = next.replace(new RegExp(`\\n?${SPLASH_MARK_START}[\\s\\S]*?${SPLASH_MARK_END}`, 'g'), '');
    next = next.replace('</head>', `\n${START}\n${INSTALL_META.join('\n')}\n${END}\n${SPLASH_STYLE_START}\n${SPLASH_STYLE}\n${SPLASH_STYLE_END}\n</head>`);
    // Pin #root empty (no whitespace, so :empty is exact) and hang the splash
    // off it; the CSS hides the splash as soon as React's first commit makes it
    // non-empty. The splash must be the immediate next sibling for that selector.
    const rootTag = next.match(/<div id="root">\s*<\/div>/);
    if (rootTag === null) {
        throw new Error('index.html has no empty #root; refusing to finalize a shell without a mount point');
    }
    const splash = `<div id="muxr-splash" aria-hidden="true">${splashMarkSvg(faviconSource)}</div>`;
    return next.replace(rootTag[0], `<div id="root"></div>\n${SPLASH_MARK_START}\n${splash}\n${SPLASH_MARK_END}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const finalized = finalizeWebExport(readFileSync(indexPath, 'utf8'), readFileSync(faviconPath, 'utf8'));
    const workerPath = join(dirname(indexPath), 'sw.js');
    const workerSource = readFileSync(workerPath, 'utf8');
    const version = shellVersion(finalized, workerSource);
    writeFileSync(indexPath, finalized);
    writeFileSync(workerPath, finalizeServiceWorker(workerSource, version));
    process.stdout.write(`finalizeWebExport: install metadata, web splash, and shell version ${version} written\n`);
}
