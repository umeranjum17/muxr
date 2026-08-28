#!/usr/bin/env node
/**
 * Package architecture guard: bounded-context ownership and readable control flow.
 * Fails if a context reaches into another context's internals, if domain code
 * depends on infrastructure, or if a nested ternary sneaks back in.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const SRC_TREES = [join(ROOT, 'contract/src'), join(ROOT, 'crypto/src')];
const CONTEXTS = ['herd', 'control-plane', 'peer', 'plugins', 'realtime', 'worktree', 'e2ee', 'shared'];
const INTERNAL = new RegExp(`/(${CONTEXTS.join('|')})/(domain|infrastructure)/`);
const NESTED_TERNARY = /\?[^?:\n]+:[^?:\n]*\?/;
const INFRA_IMPORT = /from ['"][^'"]*\/infrastructure\//;
const FORBIDDEN_DOMAIN_DEPS = /from ['"](?:tweetnacl|zod|node:)/;

const failures = [];

function walk(dir, files = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === 'dist' || entry.startsWith('.')) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path, files);
        else if (entry.endsWith('.ts')) files.push(path);
    }
    return files;
}

function contextOf(file) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const match = rel.match(/src\/([^/]+)\//);
    return match?.[1];
}

function isPackageRoot(file) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    return /src\/(?:index|selfCheck)\.ts$/.test(rel);
}

for (const tree of SRC_TREES) {
    for (const file of walk(tree)) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(ROOT, file);
        const owner = contextOf(file);
        const domainFile = /\/domain\//.test(file);
        text.split('\n').forEach((line, index) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            if (line.includes(' extends ')) return;
            if (NESTED_TERNARY.test(line) && !line.includes('??') && !line.includes('\\?') && !/[=:]\s*\//.test(line)) {
                failures.push(`${rel}:${index + 1}: nested ternary`);
            }
            const internal = line.match(INTERNAL);
            if (internal) {
                const imported = internal[1];
                const crossing = owner !== imported && !isPackageRoot(file);
                const rootReachingIn = isPackageRoot(file);
                if (crossing || rootReachingIn) {
                    failures.push(`${rel}:${index + 1}: import of ${imported} internals; use that context's index`);
                }
            }
            if (domainFile && INFRA_IMPORT.test(line)) {
                failures.push(`${rel}:${index + 1}: domain must not import infrastructure`);
            }
            if (domainFile && FORBIDDEN_DOMAIN_DEPS.test(line)) {
                failures.push(`${rel}:${index + 1}: domain must stay pure TypeScript`);
            }
        });
    }
}

if (failures.length > 0) {
    console.error(`package architecture violated:\n${failures.join('\n')}`);
    process.exit(1);
}
console.log('package architecture: context boundaries and control-flow guards hold');
