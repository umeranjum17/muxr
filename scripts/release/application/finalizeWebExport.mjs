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
 * The index.html step is idempotent: a re-run replaces its own block and Expo's
 * favicon link, leaving one icon link for the runtime attention switcher to
 * update. The sw.js step consumes its version token, so a re-run needs a fresh
 * export (web:export always runs one). Fails closed:
 * an index.html without the shape it expects (one <head>, one viewport meta) aborts the
 * export rather than shipping a shell that would install without a manifest.
 * Adds no scripts, so the CSP (script-src 'self') is untouched.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const indexPath = process.argv[2] ?? join(root, 'apps', 'mobile', 'dist', 'index.html');

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

// The worker carries this token and the export replaces it with the shell hash.
export const SHELL_VERSION_TOKEN = '__MUXR_SHELL_VERSION__';

export function shellVersion(html) {
    return createHash('sha256').update(html).digest('hex').slice(0, 16);
}

export function finalizeServiceWorker(source, version) {
    if (!source.includes(SHELL_VERSION_TOKEN)) {
        throw new Error('sw.js carries no shell version token; refusing to ship it');
    }
    return source.replaceAll(SHELL_VERSION_TOKEN, version);
}

export function finalizeWebExport(html) {
    if ((html.match(/<head[\s>]/g) ?? []).length !== 1 || !html.includes('</head>')) {
        throw new Error('index.html has no single <head>; refusing to finalize an unexpected shell');
    }
    const viewports = html.match(/<meta name="viewport"[^>]*>/g) ?? [];
    if (viewports.length !== 1) {
        throw new Error(`index.html has ${viewports.length} viewport metas; expected exactly one`);
    }
    let next = html.replace(viewports[0], VIEWPORT);
    next = next.replace(/<link\b[^>]*rel="icon"[^>]*>/g, '');
    next = next.replace(new RegExp(`\\s*${START}[\\s\\S]*?${END}\\s*`), '');
    return next.replace('</head>', `\n${START}\n${INSTALL_META.join('\n')}\n${END}\n</head>`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const finalized = finalizeWebExport(readFileSync(indexPath, 'utf8'));
    const workerPath = join(dirname(indexPath), 'sw.js');
    const version = shellVersion(finalized);
    const worker = finalizeServiceWorker(readFileSync(workerPath, 'utf8'), version);
    writeFileSync(indexPath, finalized);
    writeFileSync(workerPath, worker);
    process.stdout.write(`finalizeWebExport: install metadata and shell version ${version} written\n`);
}
