import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const MODULES = ['admission', 'routing'] as const;
const COMPOSITION = new Set(['main.ts', 'relay.ts', 'httpJson.ts', 'config.ts', 'index.ts', 'architecture.test.ts']);

// Bidirectional module dependency pairs measured at the 2026 structure
// investigation: none. The ratchet may only shrink (it starts empty), and any
// new pair fails the check.
const allowedModuleCycles: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (name.endsWith('.ts')) out.push(path);
    }
    return out;
}

function importsOf(source: string): string[] {
    return [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

function moduleOf(file: string): string | undefined {
    const rel = relative(SRC, file).replaceAll('\\', '/');
    const top = rel.split('/')[0];
    if (MODULES.includes(top as typeof MODULES[number])) return top;
    return undefined;
}

function layerOf(file: string): string | undefined {
    const rel = relative(SRC, file).replaceAll('\\', '/');
    const parts = rel.split('/');
    if (parts.length < 2) return undefined;
    if (parts[1] === 'domain' || parts[1] === 'application' || parts[1] === 'infrastructure') return parts[1];
    return undefined;
}

describe('relay runtime architecture', () => {
    const files = walk(SRC);

    it('rejects nested ternaries', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
            const containsConditional = (node: ts.Node): boolean => {
                let found = false;
                ts.forEachChild(node, (child) => {
                    if (ts.isConditionalExpression(child) || containsConditional(child)) found = true;
                });
                return found;
            };
            const visit = (node: ts.Node): void => {
                if (ts.isConditionalExpression(node)
                    && (containsConditional(node.whenTrue) || containsConditional(node.whenFalse))) {
                    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                    offenders.push(`${relative(SRC, file)}:${line}`);
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
        expect(offenders).toEqual([]);
    });

    it('keeps domain pure and forbids cross-module internals', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const rel = relative(SRC, file).replaceAll('\\', '/');
            const source = readFileSync(file, 'utf8');
            const module = moduleOf(file);
            const layer = layerOf(file);
            if (layer === 'domain') {
                if (/from ['"]node:(fs|http|net|child_process)['"]/.test(source) || /from ['"]ws['"]/.test(source)) {
                    offenders.push(`${rel} domain imports I/O`);
                }
                if (importsOf(source).some((spec) => spec.includes('/infrastructure/'))) {
                    offenders.push(`${rel} domain imports infrastructure`);
                }
            }
            for (const spec of importsOf(source)) {
                const cross = spec.match(/^(\.\.\/)+(admission|routing)\/(domain|application|infrastructure)\//);
                if (cross && cross[2] !== module) offenders.push(`${rel} -> ${spec}`);
            }
            if (COMPOSITION.has(rel)) {
                for (const spec of importsOf(source)) {
                    if (!spec.startsWith('.')) continue;
                    const internal = spec.match(/^\.\/(admission|routing)\/(domain|application|infrastructure)\//);
                    if (internal) offenders.push(`${rel} composition -> ${spec}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('has no import cycles between modules', () => {
        const edges = new Map<string, Set<string>>();
        for (const file of files) {
            if (file.endsWith('.test.ts')) continue;
            const module = moduleOf(file);
            if (module === undefined) continue;
            for (const spec of importsOf(readFileSync(file, 'utf8'))) {
                const cross = spec.match(/^(\.\.\/)+(\w+)\//);
                if (cross === null) continue;
                const target = cross[2]!;
                if (target === module || !MODULES.includes(target as typeof MODULES[number])) continue;
                if (!edges.has(module)) edges.set(module, new Set());
                edges.get(module)!.add(target);
            }
        }
        const pairs = new Set<string>();
        for (const [a, targets] of edges) {
            for (const b of targets) {
                if (edges.get(b)?.has(a)) pairs.add([a, b].sort().join('<->'));
            }
        }
        const newCycles = [...pairs].filter((pair) => !allowedModuleCycles.includes(pair));
        const staleEntries = allowedModuleCycles.filter((pair) => !pairs.has(pair));
        expect(newCycles).toEqual([]);
        expect(staleEntries).toEqual([]);
    });

    it('forbids a services folder', () => {
        const services = files.filter((file) => relative(SRC, file).replaceAll('\\', '/').includes('/services/'));
        expect(services).toEqual([]);
    });
});
