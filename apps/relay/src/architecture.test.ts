import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const CONTEXTS = ['admission', 'routing', 'push'] as const;
const COMPOSITION = new Set(['main.ts', 'relay.ts', 'httpHandlers.ts', 'config.ts', 'index.ts', 'selfCheck.ts', 'architecture.test.ts']);
const RELAY_USE_CASES = [
    'admission/application/admitSocket.ts',
    'admission/application/pairMachine.ts',
    'routing/application/routeEnvelope.ts',
];

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

function contextOf(file: string): string | undefined {
    const rel = relative(SRC, file).replaceAll('\\', '/');
    const top = rel.split('/')[0];
    if (CONTEXTS.includes(top as typeof CONTEXTS[number])) return top;
    return undefined;
}

function layerOf(file: string): string | undefined {
    const rel = relative(SRC, file).replaceAll('\\', '/');
    const parts = rel.split('/');
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

    it('keeps domain pure and forbids cross-context internals', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const rel = relative(SRC, file).replaceAll('\\', '/');
            const source = readFileSync(file, 'utf8');
            const context = contextOf(file);
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
                const cross = spec.match(/^\.\.\/\.\.\/(admission|routing|push)\/(domain|application|infrastructure)\//);
                if (cross && cross[1] !== context) offenders.push(`${rel} -> ${spec}`);
            }
            if (COMPOSITION.has(rel)) {
                for (const spec of importsOf(source)) {
                    if (!spec.startsWith('.')) continue;
                    const internal = spec.match(/^\.\/(admission|routing|push)\/(domain|application|infrastructure)\//);
                    if (internal) offenders.push(`${rel} composition -> ${spec}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('exposes named use cases and forbids a services folder', () => {
        const missing = RELAY_USE_CASES.filter((file) => !existsSync(join(SRC, file)));
        expect(missing).toEqual([]);
        const services = files.filter((file) => relative(SRC, file).replaceAll('\\', '/').includes('/services/'));
        expect(services).toEqual([]);
        const applicationIo: string[] = [];
        for (const file of files) {
            if (layerOf(file) !== 'application') continue;
            const rel = relative(SRC, file).replaceAll('\\', '/');
            if (rel.endsWith('.test.ts')) continue;
            const source = readFileSync(file, 'utf8');
            if (/from ['"]ws['"]/.test(source) || /from ['"]node:(http|net)['"]/.test(source)) {
                applicationIo.push(rel);
            }
        }
        expect(applicationIo).toEqual([]);
    });
});
