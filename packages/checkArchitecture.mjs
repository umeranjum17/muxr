#!/usr/bin/env node
/**
 * Package architecture guard: module ownership, pure domain modules,
 * and readable control flow. Fails if a module reaches into another
 * module's internals, if layers invert, if a services folder appears,
 * if module import cycles appear, or if a nested ternary sneaks back in.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const SRC_TREES = [join(ROOT, 'contract/src'), join(ROOT, 'crypto/src')];
const MODULES = [...new Set(SRC_TREES.flatMap((tree) => readdirSync(tree).filter((entry) => statSync(join(tree, entry)).isDirectory())))];
const INTERNAL = new RegExp(`/(${MODULES.join('|')})/(domain|infrastructure|application)/`);
const NESTED_TERNARY = /\?[^?:\n]+:[^?:\n]*\?/;
const INFRA_IMPORT = /from ['"][^'"]*\/infrastructure\//;
const APP_IMPORT = /from ['"][^'"]*\/application\//;
const FORBIDDEN_DOMAIN_DEPS = /from ['"](?:tweetnacl|zod|node:)/;
const FORBIDDEN_APP_DEPS = /from ['"](?:react|react-native|expo|express|ws)['"]/;
const FAKE_DDD = /\b(BaseEntity|AggregateRoot|IRepository|UnitOfWork|Injectable)\b/;

const failures = [];
const edges = new Map();

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

for (const tree of SRC_TREES) {
    for (const file of walk(tree)) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(ROOT, file).replaceAll('\\', '/');
        const owner = contextOf(file);
        const domainFile = /\/domain\//.test(file);
        const infraFile = /\/infrastructure\//.test(file);
        const applicationFile = /\/application\//.test(file);
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
                    failures.push(`${rel}:${index + 1}: import of ${imported} internals; use that module's index`);
                }
                if (owner !== undefined && owner !== imported && !isPackageRoot(file)) {
                    if (!edges.has(owner)) edges.set(owner, new Set());
                    edges.get(owner).add(imported);
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

const pairs = new Set();
for (const [a, targets] of edges) {
    for (const b of targets) {
        if (edges.get(b)?.has(a)) pairs.add([a, b].sort().join('<->'));
    }
}
if (pairs.size > 0) {
    failures.push(`module import cycles: ${[...pairs].sort().join(', ')}`);
}

if (failures.length > 0) {
    console.error(`package architecture violated:\n${failures.join('\n')}`);
    process.exit(1);
}
console.log('package architecture: module boundaries, domain purity, and control-flow guards hold');
