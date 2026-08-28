#!/usr/bin/env node
/**
 * Tooling architecture guard: bounded-context folders own their internals.
 * Other contexts may import only a public index. Domain stays I/O-free.
 * Nested ternaries are rejected in first-party tooling files.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTEXTS = ['setup', 'plugin', 'release', 'diagnostics'];
const DOMAIN_IO = /\bfrom ['"]node:(fs|net|http|https|child_process|os|dgram)(?:\/[^'"]*)?['"]/;
const NESTED_TERNARY = /\?[^?:.\n]{1,80}:[^?:.\n]{0,80}\?(?![`'"])/;
const failures = [];

function walk(dir, files = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, files);
        else if (/\.(mjs|js|ts)$/.test(entry.name)) files.push(path);
    }
    return files;
}

function contextOf(file) {
    const rel = relative(join(ROOT, 'scripts'), file);
    if (rel.startsWith('..')) return undefined;
    const first = rel.split(/[\\/]/)[0];
    return CONTEXTS.includes(first) ? first : undefined;
}

function layerOf(file) {
    const rel = relative(join(ROOT, 'scripts'), file);
    const parts = rel.split(/[\\/]/);
    if (parts[1] === 'domain') return 'domain';
    if (parts[1] === 'application') return 'application';
    if (parts[1] === 'infrastructure') return 'infrastructure';
    if (parts[1] === 'presentation') return 'presentation';
    if (parts[1] === 'index.mjs') return 'index';
    return undefined;
}

function importedPath(file, specifier) {
    if (!specifier.startsWith('.')) return undefined;
    return join(dirname(file), specifier);
}

const toolingDirs = [
    join(ROOT, 'scripts'),
    join(ROOT, 'plugins'),
    join(ROOT, 'apps', 'mobile', 'plugins'),
];
const files = toolingDirs.flatMap((dir) => walk(dir));

for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    const lines = text.split('\n');
    lines.forEach((line, index) => {
        if (line.includes('NESTED_TERNARY') || line.includes('nested ternary')) return;
        if (line.includes('?.') || line.includes('??')) return;
        if (line.includes('.replace(/') || line.includes('.match(/') || /\/[gimsuy]*,/.test(line)) return;
        if (NESTED_TERNARY.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
            failures.push(`${rel}:${index + 1}: nested ternary`);
        }
    });

    const context = contextOf(file);
    const layer = layerOf(file);
    if (layer === 'domain' && DOMAIN_IO.test(text)) {
        failures.push(`${rel}: domain imports I/O`);
    }
    if (context === undefined) continue;
    for (const match of text.matchAll(/(?:from ['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\))/g)) {
        const specifier = match[1] ?? match[2];
        const target = importedPath(file, specifier.replace(/\.js$/, '.ts'));
        const alt = importedPath(file, specifier);
        const other = contextOf(alt) ?? contextOf(target ?? '');
        if (other !== undefined && other !== context) {
            const allowedIndex = alt.endsWith(`${other}/index.mjs`) || alt.endsWith(`${other}/index.js`);
            if (!allowedIndex && layer !== 'index') {
                failures.push(`${rel}: cross-context internal import of ${relative(ROOT, alt)}`);
            }
        }
        if (layer === 'domain') {
            const destLayer = layerOf(alt);
            if (destLayer === 'application' || destLayer === 'infrastructure' || destLayer === 'presentation') {
                failures.push(`${rel}: domain imports ${destLayer}`);
            }
        }
        if (layer === 'infrastructure') {
            const destLayer = layerOf(alt);
            if (destLayer === 'application' || destLayer === 'presentation') {
                failures.push(`${rel}: infrastructure imports ${destLayer}`);
            }
        }
    }
}

if (failures.length > 0) {
    process.stderr.write(`tooling architecture violated:\n${failures.join('\n')}\n`);
    process.exit(1);
}
process.stdout.write(`architecture: ${files.length} files, contexts isolated, domain I/O-free, no nested ternaries\n`);
