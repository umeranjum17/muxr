#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const sets = [
  { name: 'Google Play', dir: path.join(repo, 'docs/play/store-assets/aso'), width: 1080, height: 1920, max: 8 },
  { name: 'App Store iPhone 6.9-inch', dir: path.join(repo, 'docs/app-store/screenshots'), width: 1320, height: 2868, max: 10 },
  { name: 'App Store iPad 13-inch', dir: path.join(repo, 'docs/app-store/screenshots-ipad'), width: 2064, height: 2752, max: 10 },
];

for (const set of sets) {
  const files = (await readdir(set.dir)).filter((file) => file.endsWith('.png')).sort();
  if (files.length < 4 || files.length > set.max) throw new Error(`${set.name}: expected 4–${set.max} PNGs, got ${files.length}`);
  for (const file of files) {
    const full = path.join(set.dir, file);
    const { stdout } = await exec('magick', ['identify', '-format', '%w|%h|%[opaque]|%[colorspace]', full]);
    const [width, height, opaque, colorSpace] = stdout.trim().split('|');
    if (+width !== set.width || +height !== set.height) throw new Error(`${set.name}/${file}: ${width}×${height}, expected ${set.width}×${set.height}`);
    if (opaque !== 'True') throw new Error(`${set.name}/${file}: alpha/transparency is not allowed`);
    if (colorSpace.toLowerCase() !== 'srgb') throw new Error(`${set.name}/${file}: expected sRGB, got ${colorSpace}`);
    if (set.name === 'Google Play' && Math.max(+width, +height) > 2 * Math.min(+width, +height)) {
      throw new Error(`${set.name}/${file}: long side exceeds 2× short side`);
    }
  }
  console.log(`PASS ${set.name}: ${files.length} opaque sRGB screenshots at ${set.width}×${set.height}`);
}
