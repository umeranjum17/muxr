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
                if (ctx && new RegExp(`from ['"]\\./\\.\\./(application|presentation)/`).test(trimmed)) {
                    failures.push(`${rel}: domain imports ${trimmed}`);
                }
            }
        }
        expect(failures).toEqual([]);
    });

    it('rejects nested ternaries in domain modules', () => {
        const failures: string[] = [];
        for (const file of files) {
            const rel = path.relative(sources, file);
            if (!rel.includes('/domain/') || rel.endsWith('.spec.ts')) continue;
            const body = strip(fs.readFileSync(file, 'utf8'))
                .split('\n')
                .filter((line) => !line.includes(' extends '))
                .join('\n');
            // Value ternary `a ? b : c ? d : e` — not `name?: Type` or `?.`.
            if (/\s\?\s[^?:\n]{1,120}\s:\s[^?:\n]{1,80}\s\?\s/.test(body)) {
                failures.push(rel);
            }
        }
        expect(failures).toEqual([]);
    });
});
