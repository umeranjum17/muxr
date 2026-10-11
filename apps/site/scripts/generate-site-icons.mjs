#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
export const SITE_ICON_OUTPUTS = ['favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png', 'favicon.ico', 'favicon.svg']
    .map((name) => `docs/icons/${name}`);

export function generateSiteIcons() {
    const dir = join(root, 'docs/icons');
    const source = join(dir, 'muxr-app-icon.png');
    for (const [name, size] of [['favicon-16.png', 16], ['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
        execFileSync('magick', [source, '-filter', 'Lanczos', '-resize', `${size}x${size}`, '-strip', join(dir, name)]);
    }
    execFileSync('magick', [source, '-define', 'icon:auto-resize=48,32,16', join(dir, 'favicon.ico')]);
    writeFileSync(join(dir, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024"><image width="1024" height="1024" xlink:href="data:image/png;base64,${readFileSync(source).toString('base64')}"/></svg>\n`);
}
