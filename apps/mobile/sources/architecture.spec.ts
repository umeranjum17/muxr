import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sources = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const overlay = path.join(sources, '..', 'modules', 'voice-overlay');
const uiContexts = [
    'herd', 'spawn', 'pairing', 'settings', 'plugins', 'terminal',
    'collaboration', 'preview', 'takeover', 'changelog',
] as const;
const runtimeContexts = [
    'catalog', 'watch', 'connection', 'pairing', 'conversation', 'playback', 'account',
] as const;
const layers = ['domain', 'application', 'infrastructure', 'presentation'] as const;
const removedShims = ['sync', 'state', 'realtime', 'voice', 'auth', 'client'] as const;
const presentationOnly = new Set(['settings']);
const uiUseCases = [
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
const runtimeUseCases = [
    'catalog/application/startAgent.ts',
    'catalog/application/promptAgent.ts',
    'catalog/application/readAgentFile.ts',
    'catalog/application/readAgentSession.ts',
    'catalog/application/stopAgent.ts',
    'watch/application/watchAgentLifecycle.ts',
    'watch/application/reportAgentOutcome.ts',
    'pairing/application/forgetMachine.ts',
    'pairing/application/restoreConnection.ts',
    'conversation/application/startRealtimeConversation.ts',
    'conversation/application/startDictation.ts',
    'conversation/application/stopRealtimeConversation.ts',
    'conversation/application/focusAgent.ts',
    'playback/application/interruptPlayback.ts',
    'account/application/validateAccountCredential.ts',
] as const;
const useCases = [...uiUseCases, ...runtimeUseCases];
const forbiddenUseCaseImports = /^(react|react-native|expo($|\/)|expo-)|@\/(modal|client\/muxrClient)|voice-overlay|modules\/voice-overlay/;

function walk(dir: string, files: string[] = []): string[] {
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.') || entry === 'translations') continue;
        const full = path.join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            if ((removedShims as readonly string[]).includes(entry)) continue;
            walk(full, files);
        } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.spec.ts')) {
            files.push(full);
        }
    }
    return files;
}

function listedUseCases(index: string, prefix?: readonly string[]): string[] {
    const listed = index.split('\n').flatMap((line) => {
        const match = line.match(/^\| [^|]+ \| `([a-z]+\/application\/[A-Za-z]+)\.ts` \|/);
        return match === null ? [] : [`${match[1]}.ts`];
    });
    const unique = [...new Set(listed)];
    if (prefix === undefined) return unique;
    return unique.filter((rel) => prefix.includes(rel.split('/')[0]));
}

function importSpecs(source: string): string[] {
    const specs: string[] = [];
    const re = /from ['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) specs.push(match[1]);
    return specs;
}

function isTypeOnlyImportLine(line: string): boolean {
    return /^\s*import\s+type\s/.test(line);
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

describe('mobile bounded contexts', () => {
    it('has no compatibility shims for old technical folders', () => {
        const present = removedShims.filter((name) => existsSync(path.join(sources, name)));
        expect(present).toEqual([]);
    });

    it('rejects cross-context internal imports and domain React', () => {
        const uiInternal = new RegExp(
            `from ['"]@/(${uiContexts.join('|')})/(${layers.join('|')})/`,
        );
        const runtimeInternal = new RegExp(
            `from ['"]@/(${runtimeContexts.join('|')})/(${layers.join('|')})/`,
        );
        const failures: string[] = [];
        for (const file of files) {
            const rel = path.relative(sources, file);
            const src = readFileSync(file, 'utf8');
            const top = rel.split('/')[0];
            const inUi = (uiContexts as readonly string[]).includes(top);
            const inRuntime = (runtimeContexts as readonly string[]).includes(top);
            for (const line of src.split('\n')) {
                if (inUi) {
                    const match = line.match(uiInternal);
                    if (match && match[1] !== top) {
                        failures.push(`${rel}: internal import ${match[0]}`);
                    }
                }
                if (inRuntime) {
                    const match = line.match(runtimeInternal);
                    if (match && match[1] !== top) {
                        failures.push(`${rel}: internal import ${match[0]}`);
                    }
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

    it('keeps domain free of outer layers and fetch in runtime contexts', () => {
        const violations: string[] = [];
        for (const context of runtimeContexts) {
            const contextRoot = path.join(sources, context);
            for (const file of walk(contextRoot)) {
                const rel = path.relative(sources, file);
                const source = readFileSync(file, 'utf8');
                const inDomain = rel.split(path.sep)[1] === 'domain';
                for (const spec of importSpecs(source)) {
                    const line = source.split('\n').find((candidate) => candidate.includes(`'${spec}'`) || candidate.includes(`"${spec}"`)) ?? '';
                    if (inDomain && !isTypeOnlyImportLine(line)) {
                        if (/\/(application|infrastructure|presentation)\//.test(spec)) {
                            violations.push(`${rel} domain imports outer layer ${spec}`);
                        }
                        if (/^(react|react-native|expo($|\/)|expo-)/.test(spec)) {
                            violations.push(`${rel} domain imports platform module ${spec}`);
                        }
                    }
                    if (/^@\/(sync|state|realtime|voice|auth|client)\//.test(spec)) {
                        violations.push(`${rel} imports removed shim ${spec}`);
                    }
                }
                if (inDomain && /\bfetch\s*\(/.test(source)) {
                    violations.push(`${rel} domain performs fetch`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it('keeps presentation off public context barrels except settings', () => {
        const failures: string[] = [];
        const contexts = [...new Set([...uiContexts, ...runtimeContexts])];
        for (const ctx of contexts) {
            if (presentationOnly.has(ctx)) continue;
            const index = path.join(sources, ctx, 'index.ts');
            if (!existsSync(index)) continue;
            const src = readFileSync(index, 'utf8');
            if (src.includes("from './presentation/")) {
                failures.push(`${ctx}/index.ts exports presentation`);
            }
        }
        expect(failures).toEqual([]);
    });

    it('rejects nested ternaries in domain, named use cases, and runtime files', () => {
        const failures: string[] = [];
        const useCaseSet = new Set(useCases);
        for (const file of files) {
            const rel = path.relative(sources, file);
            const isUseCase = useCaseSet.has(rel);
            const inRuntime = (runtimeContexts as readonly string[]).includes(rel.split('/')[0])
                || rel.startsWith('encryption/');
            if ((!rel.includes('/domain/') && !isUseCase && !inRuntime) || rel.endsWith('.spec.ts')) continue;
            const body = strip(readFileSync(file, 'utf8'))
                .split('\n')
                .filter((line) => !line.includes(' extends '))
                .join('\n');
            if (/\s\?\s[^?:\n]{1,120}\s:\s[^?:\n]{1,80}\s\?\s/.test(body)) {
                failures.push(rel);
            }
        }
        for (const file of walk(overlay)) {
            const rel = path.relative(sources, file);
            const lines = readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, index) => {
                const stripped = line.replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, '``').replace(/\/\/.*$/, '');
                if (/ \? [^)?:\n]+ : [^)?\n]* \? /.test(stripped)) {
                    failures.push(`${rel}:${index + 1}`);
                }
            });
        }
        expect(failures).toEqual([]);
    });

    it('maps each real operation to a named use case with a command and no UI', () => {
        expect(existsSync(path.join(sources, 'USE_CASES.md'))).toBe(true);
        expect(existsSync(path.join(sources, 'services'))).toBe(false);
        const index = readFileSync(path.join(sources, 'USE_CASES.md'), 'utf8');
        expect(listedUseCases(index).sort()).toEqual([...useCases].sort());

        const failures: string[] = [];
        for (const context of [...uiContexts, ...runtimeContexts]) {
            for (const folder of ['services', path.join('application', 'services')]) {
                if (existsSync(path.join(sources, context, folder))) {
                    failures.push(`${context}/${folder.replace(path.sep, '/')} must not exist`);
                }
            }
        }
        for (const rel of useCases) {
            const file = path.join(sources, rel);
            if (!existsSync(file)) {
                failures.push(`missing ${rel}`);
                continue;
            }
            const src = readFileSync(file, 'utf8');
            if (!/export type \w+Command\b/.test(src) && rel !== 'conversation/application/stopRealtimeConversation.ts'
                && rel !== 'playback/application/interruptPlayback.ts') {
                failures.push(`${rel}: missing Command type`);
            }
            const exported = rel.split('/').pop()!.replace(/\.ts$/, '');
            const camel = exported.charAt(0).toLowerCase() + exported.slice(1);
            if (!src.includes(`export async function ${camel}`) && !src.includes(`export function ${camel}`)) {
                failures.push(`${rel} must export ${camel}`);
            }
            const runtime = (runtimeUseCases as readonly string[]).includes(rel);
            if (runtime) {
                for (const spec of importSpecs(src)) {
                    if (forbiddenUseCaseImports.test(spec)) {
                        failures.push(`${rel} imports ${spec}`);
                    }
                }
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
            if (/\bfetch\s*\(/.test(src)) failures.push(`${rel} performs fetch`);
        }
        expect(failures).toEqual([]);
    });
});
