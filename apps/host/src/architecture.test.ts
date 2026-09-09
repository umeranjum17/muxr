import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const CONTEXTS = ['agent', 'machine', 'peer', 'requests', 'diagnostics'] as const;
const COMPOSITION = new Set(['main.ts', 'host.ts', 'host.test.ts', 'architecture.test.ts']);
const HOST_USE_CASES = [
    'agent/application/startAgent.ts',
    'agent/application/promptAgent.ts',
    'agent/application/openAgent.ts',
    'agent/application/readAgentSession.ts',
    'agent/application/watchAgentLifecycle.ts',
    'agent/application/focusAgent.ts',
    'agent/application/stopAgent.ts',
    'agent/application/answerAgent.ts',
    'agent/application/listAgents.ts',
    'agent/application/reportAgentOutcome.ts',
    'agent/application/runPluginAction.ts',
    'agent/application/openTerminal.ts',
    'machine/application/reconnectMachine.ts',
    'machine/application/listMachines.ts',
    'peer/application/grantPeerAuthority.ts',
    'peer/application/revokePeerAuthority.ts',
    'peer/application/admitPeerRequest.ts',
    'requests/application/attachPreviewTunnel.ts',
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
    if (parts.length < 2) return undefined;
    if (parts[1] === 'domain' || parts[1] === 'application' || parts[1] === 'infrastructure') return parts[1];
    return undefined;
}

describe('host runtime architecture', () => {
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
                const cross = spec.match(/^\.\.\/\.\.\/(agent|machine|peer|requests|diagnostics)\/(domain|application|infrastructure)\//);
                if (cross && cross[1] !== context) offenders.push(`${rel} -> ${spec}`);
            }
            if (COMPOSITION.has(rel)) {
                for (const spec of importsOf(source)) {
                    if (!spec.startsWith('.')) continue;
                    const internal = spec.match(/^\.\/(agent|machine|peer|requests|diagnostics)\/(domain|application|infrastructure)\//);
                    if (internal) offenders.push(`${rel} composition -> ${spec}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('exposes named use cases and forbids a services folder', () => {
        const missing = HOST_USE_CASES.filter((file) => !existsSync(join(SRC, file)));
        expect(missing).toEqual([]);
        const services = files.filter((file) => relative(SRC, file).replaceAll('\\', '/').includes('/services/'));
        expect(services).toEqual([]);
        const applicationIo: string[] = [];
        for (const file of files) {
            const layer = layerOf(file);
            if (layer !== 'application') continue;
            const rel = relative(SRC, file).replaceAll('\\', '/');
            if (rel.endsWith('.test.ts')) continue;
            if (rel.endsWith('/sessionSource.ts') || rel.endsWith('/watchStores.ts') || rel.endsWith('/runtime.ts')
                || rel.endsWith('/createRequestDispatcher.ts') || rel.endsWith('/outboundPeerService.ts')
                || rel.endsWith('/receiptExecutor.ts')) continue;
            const source = readFileSync(file, 'utf8');
            if (/from ['"]ws['"]/.test(source) || /from ['"]node:(http|net)['"]/.test(source)) {
                applicationIo.push(rel);
            }
        }
        expect(applicationIo).toEqual([]);
    });
});
