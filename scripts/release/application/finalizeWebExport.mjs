#!/usr/bin/env node
/**
 * Finish the web export's index.html.
 *
 * `expo export` with `web.output: "single"` renders its own SPA template
 * and never consults a +html.tsx, so the install metadata the PWA needs
 * (manifest link, Apple web-app meta, touch icon, the keyboard-resizing
 * viewport) has to be written into the built file. This runs right after
 * the export as part of `web:export`, so every consumer of dist/ -- the
 * self-host deploy, the demo, the diagnostics -- receives the same shell.
 *
 * Idempotent: a re-run replaces its own block. Fails closed: an index.html
 * without the shape it expects (one <head>, one viewport meta) aborts the
 * export rather than shipping a shell that would install without a manifest.
 * Adds no scripts, so the CSP (script-src 'self') is untouched.
 */
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
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="apple-touch-icon" href="/icon-192.png">',
];
const START = '<!-- muxr:install-meta -->';
const END = '<!-- /muxr:install-meta -->';
export const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, interactive-widget=resizes-content" />';

export function finalizeWebExport(html) {
    if ((html.match(/<head[\s>]/g) ?? []).length !== 1 || !html.includes('</head>')) {
        throw new Error('index.html has no single <head>; refusing to finalize an unexpected shell');
    }
    const viewports = html.match(/<meta name="viewport"[^>]*>/g) ?? [];
    if (viewports.length !== 1) {
        throw new Error(`index.html has ${viewports.length} viewport metas; expected exactly one`);
    }
    let next = html.replace(viewports[0], VIEWPORT);
    next = next.replace(new RegExp(`\\s*${START}[\\s\\S]*?${END}`), '');
    return next.replace('</head>', `\n${START}\n${INSTALL_META.join('\n')}\n${END}\n</head>`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const finalized = finalizeWebExport(readFileSync(indexPath, 'utf8'));
    writeFileSync(indexPath, finalized);
    process.stdout.write(`finalizeWebExport: install metadata written to ${indexPath}\n`);
}
