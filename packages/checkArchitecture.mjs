#!/usr/bin/env node
/**
 * Package architecture guard: bounded-context ownership, named use cases,
 * and readable control flow. Fails if a context reaches into another
 * context's internals, if layers invert, if a services folder appears,
 * or if a nested ternary sneaks back in.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const SRC_TREES = [join(ROOT, 'contract/src'), join(ROOT, 'crypto/src')];
const USE_CASES = join(ROOT, 'USE_CASES.md');
const CONTEXTS = ['herd', 'control-plane', 'peer', 'plugins', 'realtime', 'worktree', 'e2ee', 'shared'];
const INTERNAL = new RegExp(`/(${CONTEXTS.join('|')})/(domain|infrastructure|application)/`);
const NESTED_TERNARY = /\?[^?:\n]+:[^?:\n]*\?/;
const INFRA_IMPORT = /from ['"][^'"]*\/infrastructure\//;
const APP_IMPORT = /from ['"][^'"]*\/application\//;
const FORBIDDEN_DOMAIN_DEPS = /from ['"](?:tweetnacl|zod|node:)/;
const FORBIDDEN_APP_DEPS = /from ['"](?:react|react-native|expo|express|ws)['"]/;
const FAKE_DDD = /\b(BaseEntity|AggregateRoot|IRepository|UnitOfWork|Injectable)\b/;

const failures = [];
const applicationModules = [];

function walk(dir, files = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === 'dist' || entry.startsWith('.')) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            if (entry === 'services') failures.push(`${relative(ROOT, path)}: do not add a generic services folder; name a use case`);
            walk(path, files);
        } else if (entry.endsWith('.ts')) {
            files.push(path);
        }
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

if (!existsSync(USE_CASES)) {
    failures.push('USE_CASES.md: missing application index');
}
const useCaseIndex = existsSync(USE_CASES) ? readFileSync(USE_CASES, 'utf8') : '';

for (const tree of SRC_TREES) {
    for (const file of walk(tree)) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(ROOT, file).replaceAll('\\', '/');
        const owner = contextOf(file);
        const domainFile = /\/domain\//.test(file);
        const infraFile = /\/infrastructure\//.test(file);
        const applicationFile = /\/application\//.test(file);
        if (applicationFile) applicationModules.push(rel);
        if (rel.includes('/contract/') && /from ['"]@muxr\/crypto/.test(text)) {
            failures.push(`${rel}: contract must not import crypto`);
        }
        text.split('\n').forEach((line, index) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            if (line.includes(' extends ')) return;
            if (NESTED_TERNARY.test(line) && !line.includes('??') && !line.includes('\\?') && !/[=:]\s*\//.test(line)) {
                failures.push(`${rel}:${index + 1}: nested ternary`);
            }
            if (FAKE_DDD.test(line)) {
                failures.push(`${rel}:${index + 1}: fake DDD type; put behavior on the real entity`);
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
            if (domainFile && APP_IMPORT.test(line)) {
                failures.push(`${rel}:${index + 1}: domain must not import application`);
            }
            if (infraFile && APP_IMPORT.test(line)) {
                failures.push(`${rel}:${index + 1}: infrastructure must not import application`);
            }
            if (domainFile && FORBIDDEN_DOMAIN_DEPS.test(line)) {
                failures.push(`${rel}:${index + 1}: domain must stay pure TypeScript`);
            }
            if (applicationFile && FORBIDDEN_APP_DEPS.test(line)) {
                failures.push(`${rel}:${index + 1}: use cases must not import transport/UI/native`);
            }
        });
    }
}

for (const rel of applicationModules) {
    const name = rel.split('/').pop()?.replace(/\.ts$/, '');
    if (name && !useCaseIndex.includes(name)) {
        failures.push(`${rel}: application module is missing from USE_CASES.md`);
    }
}

if (failures.length > 0) {
    console.error(`package architecture violated:\n${failures.join('\n')}`);
    process.exit(1);
}
console.log('package architecture: context boundaries, named use cases, and control-flow guards hold');
