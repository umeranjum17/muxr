import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sources = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const contexts = [
    'herd', 'spawn', 'pairing', 'settings', 'plugins', 'terminal',
    'collaboration', 'preview', 'takeover', 'changelog',
] as const;
const layers = ['domain', 'application', 'infrastructure', 'presentation'] as const;
const excluded = new Set(['sync', 'state', 'realtime', 'voice', 'auth', 'encryption']);
const presentationOnly = new Set(['settings']);
const useCases = [
    'spawn/application/StartAgent.ts',
    'spawn/application/StartAgentFromDock.ts',
    'spawn/application/LandWorktree.ts',
    'herd/application/FocusAgent.ts',
    'herd/application/WatchAgentLifecycle.ts',
    'pairing/application/PairMachine.ts',
    'pairing/application/ReconnectMachine.ts',
    'collaboration/application/GrantPeerAuthority.ts',
    'collaboration/application/RevokePeerAuthority.ts',
    'terminal/application/OpenTerminal.ts',
    'preview/application/OpenPreview.ts',
    'takeover/application/OpenTakeover.ts',
    'plugins/application/RunPluginAction.ts',
    'plugins/application/RunPluginShortcut.ts',
];

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (excluded.has(entry.name) || entry.name === 'translations') continue;
            out.push(...walk(full));
            continue;
        }
        if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

function contextOf(rel: string): string | undefined {
    const top = rel.split('/')[0];
    return contexts.includes(top as typeof contexts[number]) ? top : undefined;
}

function strip(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, '``')
        .replace(/\?\./g, '.')
        .replace(/\?\?/g, '||');
}

const files = walk(sources).filter((file) => !file.endsWith('architecture.spec.ts'));

describe('mobile UI bounded contexts', () => {
    it('rejects cross-context internal imports and domain React', () => {
        const internal = new RegExp(
            `from ['"]@/(${contexts.join('|')})/(${layers.join('|')})/`,
        );
        const failures: string[] = [];
        for (const file of files) {
            const rel = path.relative(sources, file);
            const src = fs.readFileSync(file, 'utf8');
            const ctx = contextOf(rel);
            for (const line of src.split('\n')) {
                const match = line.match(internal);
                if (match && match[1] !== ctx) {
                    failures.push(`${rel}: internal import ${match[0]}`);
                }
            }
            if (!rel.includes('/domain/')) continue;
            for (const line of src.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('import type ')) continue;
                if (/from ['"]react['"]/.test(trimmed) || /from ['"]react-native['"]/.test(trimmed)) {
                    failures.push(`${rel}: domain imports React runtime`);
                }
                if (/from ['"]expo-router['"]/.test(trimmed)) {
                    failures.push(`${rel}: domain imports expo-router`);
                }
                if (/\.\.\/(application|presentation|infrastructure)\//.test(trimmed) && /from ['"]/.test(trimmed)) {
                    failures.push(`${rel}: domain imports ${trimmed}`);
                }
                if (/from ['"]@\/[a-z]+\/ui['"]/.test(trimmed)) {
                    failures.push(`${rel}: domain imports presentation barrel ${trimmed}`);
                }
            }
        }
        expect(failures).toEqual([]);
    });

    it('keeps presentation off public context barrels except settings', () => {
        const failures: string[] = [];
        for (const ctx of contexts) {
            if (presentationOnly.has(ctx)) continue;
            const index = path.join(sources, ctx, 'index.ts');
            if (!fs.existsSync(index)) continue;
            const src = fs.readFileSync(index, 'utf8');
            if (src.includes("from './presentation/")) {
                failures.push(`${ctx}/index.ts exports presentation`);
            }
        }
        expect(failures).toEqual([]);
    });

    it('rejects nested ternaries in domain and named use-case modules', () => {
        const failures: string[] = [];
        for (const file of files) {
            const rel = path.relative(sources, file);
            const isUseCase = useCases.includes(rel);
            if ((!rel.includes('/domain/') && !isUseCase) || rel.endsWith('.spec.ts')) continue;
            const body = strip(fs.readFileSync(file, 'utf8'))
                .split('\n')
                .filter((line) => !line.includes(' extends '))
                .join('\n');
            if (/\s\?\s[^?:\n]{1,120}\s:\s[^?:\n]{1,80}\s\?\s/.test(body)) {
                failures.push(rel);
            }
        }
        expect(failures).toEqual([]);
    });

    it('maps each real operation to a named use case with a command and no UI', () => {
        expect(fs.existsSync(path.join(sources, 'USE_CASES.md'))).toBe(true);
        expect(fs.existsSync(path.join(sources, 'services'))).toBe(false);
        const failures: string[] = [];
        for (const rel of useCases) {
            const file = path.join(sources, rel);
            if (!fs.existsSync(file)) {
                failures.push(`missing ${rel}`);
                continue;
            }
            const src = fs.readFileSync(file, 'utf8');
            if (!/export type \w+Command\b/.test(src)) {
                failures.push(`${rel}: missing Command type`);
            }
            for (const line of src.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('import type ')) continue;
                if (/from ['"]react['"]/.test(trimmed) || /from ['"]react-native['"]/.test(trimmed)) {
                    failures.push(`${rel}: use case imports React`);
                }
                if (/from ['"]expo-router['"]/.test(trimmed) || /from ['"]@\/modal['"]/.test(trimmed)) {
                    failures.push(`${rel}: use case imports UI (${trimmed})`);
                }
            }
        }
        expect(failures).toEqual([]);
    });
});
