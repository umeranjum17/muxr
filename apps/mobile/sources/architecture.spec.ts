import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sources = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const overlay = path.join(sources, '..', 'modules', 'voice-overlay');

// Technical chrome is named here; features are every other top-level folder,
// so adding a feature never requires editing this file. Shared chrome
// (components/, modal/, theme, text, ...) is sanctioned by CONTRIBUTING.md.
const technicalDirs = new Set([
    'app', 'assets', 'components', 'constants', 'encryption', 'hooks', 'keyboard',
    'modal', 'navigation', 'polyfills', 'text', 'types', 'utils',
]);
const featureDirs = readdirSync(sources, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !technicalDirs.has(entry.name))
    .map((entry) => entry.name)
    .sort();
const isFeature = (name: string): boolean => featureDirs.includes(name);

// Layer folders are a feature's implementation detail. Importing them from
// another feature reaches past that feature's public entry. `model` is
// included ahead of the domain/ -> model/ rename so the check survives it.
const internalImport = /from ['"]@\/(\w+)\/(domain|model|application|infrastructure|presentation)(?=\/|'|")/;
const removedShims = ['sync', 'state', 'realtime', 'voice', 'auth', 'client'] as const;

// Bidirectional feature dependency pairs measured at the 2026 structure
// investigation. The ratchet may only shrink: a pair that disappears must be
// removed here, and any new pair fails the check.
const allowedFeatureCycles = [
    'account<->catalog', 'account<->pairing', 'catalog<->herd', 'catalog<->pairing',
    'catalog<->watch', 'connection<->pairing', 'conversation<->plugins',
    'conversation<->watch', 'herd<->plugins', 'herd<->spawn', 'herd<->terminal',
    'plugins<->watch',
];

// The old check only policed ui-context importers against ui-context targets
// (and runtime against runtime), so these cross-list internal imports slipped
// through for years. They are repointed to public barrels during the staged
// layer-folder collapse; until then the ratchet keeps them frozen: may only
// shrink, any new site fails.
const allowedInternalImports = [
    'catalog/application/storage.ts: internal import from \'@/herd/domain/',
    'herd/application/useSessionQuickActions.ts: internal import from \'@/catalog/infrastructure/',
    'herd/presentation/HerdView.tsx: internal import from \'@/catalog/infrastructure/',
    'plugins/application/capabilityRegistry.ts: internal import from \'@/watch/application/',
    'settings/presentation/ConnectionSupport.tsx: internal import from \'@/catalog/infrastructure/',
    'settings/presentation/SettingsView.tsx: internal import from \'@/catalog/infrastructure/',
    'settings/presentation/SettingsView.tsx: internal import from \'@/conversation/application/',
    'spawn/application/StartAgentFromDock.ts: internal import from \'@/catalog/application/',
    'spawn/application/StartAgentFromDock.ts: internal import from \'@/catalog/infrastructure/',
    'spawn/application/homeDockEnvironment.ts: internal import from \'@/catalog/application/',
    'spawn/application/useNewSessionDraft.ts: internal import from \'@/catalog/application/',
    'spawn/application/useNewSessionDraft.ts: internal import from \'@/catalog/infrastructure/',
    'spawn/presentation/HomeDock.tsx: internal import from \'@/catalog/application/',
    'terminal/application/OpenTerminal.ts: internal import from \'@/catalog/infrastructure/',
    'terminal/application/useGitStatusFiles.ts: internal import from \'@/catalog/infrastructure/',
    'terminal/domain/toolCommand.ts: internal import from \'@/catalog/infrastructure/',
    'terminal/domain/turnChanges.ts: internal import from \'@/catalog/infrastructure/',
    'terminal/presentation/AgentInputAttachmentStrip.tsx: internal import from \'@/catalog/infrastructure/',
    'terminal/presentation/TerminalScreen.tsx: internal import from \'@/catalog/infrastructure/',
    'terminal/presentation/TerminalView.tsx: internal import from \'@/catalog/infrastructure/',
];

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

describe('mobile features', () => {
    it('has no compatibility shims for old technical folders', () => {
        const present = removedShims.filter((name) => existsSync(path.join(sources, name)));
        expect(present).toEqual([]);
    });

    it('keeps cross-feature imports at feature public entries', () => {
        const failures: string[] = [];
        for (const file of files) {
            const rel = path.relative(sources, file);
            const top = rel.split(path.sep)[0];
            if (!isFeature(top)) continue;
            for (const line of readFileSync(file, 'utf8').split('\n')) {
                const match = line.match(internalImport);
                if (match && match[1] !== top && isFeature(match[1])) {
                    failures.push(`${rel}: internal import ${match[0]}`);
                }
            }
        }
        const newSites = failures.filter((site) => !allowedInternalImports.includes(site));
        const staleEntries = allowedInternalImports.filter((site) => !failures.includes(site));
        expect(newSites).toEqual([]);
        expect(staleEntries).toEqual([]);
    });

    it('keeps feature model folders pure', () => {
        const violations: string[] = [];
        for (const file of files) {
            const rel = path.relative(sources, file);
            const parts = rel.split(path.sep);
            if (!isFeature(parts[0])) continue;
            if (parts[1] !== 'domain' && parts[1] !== 'model') continue;
            const source = readFileSync(file, 'utf8');
            for (const line of source.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('import type ')) continue;
                if (/from ['"]react['"]/.test(trimmed) || /from ['"]react-native['"]/.test(trimmed)) {
                    violations.push(`${rel}: model imports React runtime`);
                }
                if (/from ['"]expo($|\/|-)/.test(trimmed)) {
                    violations.push(`${rel}: model imports expo`);
                }
                if (/\.\.\/(application|presentation|infrastructure)\//.test(trimmed) && /from ['"]/.test(trimmed)) {
                    violations.push(`${rel}: model imports ${trimmed}`);
                }
                if (/from ['"]@\/[a-z]+\/ui['"]/.test(trimmed)) {
                    violations.push(`${rel}: model imports presentation barrel ${trimmed}`);
                }
                if (/\/(application|infrastructure|presentation)\//.test(trimmed) && /from ['"]\./.test(trimmed)) {
                    violations.push(`${rel}: model imports outer layer ${trimmed}`);
                }
            }
            if (/\bfetch\s*\(/.test(source)) violations.push(`${rel}: model performs fetch`);
        }
        expect(violations).toEqual([]);
    });

    it('has no new import cycles between features', () => {
        const edges = new Map<string, Set<string>>();
        for (const file of files) {
            const rel = path.relative(sources, file);
            const top = rel.split(path.sep)[0];
            if (!isFeature(top)) continue;
            for (const match of readFileSync(file, 'utf8').matchAll(/from ['"]@\/(\w+)(?:[/.'"])/g)) {
                const target = match[1]!;
                if (target === top || !isFeature(target)) continue;
                if (!edges.has(top)) edges.set(top, new Set());
                edges.get(top)!.add(target);
            }
        }
        const pairs = new Set<string>();
        for (const [a, targets] of edges) {
            for (const b of targets) {
                if (edges.get(b)?.has(a)) pairs.add([a, b].sort().join('<->'));
            }
        }
        const newCycles = [...pairs].filter((pair) => !allowedFeatureCycles.includes(pair));
        const staleEntries = allowedFeatureCycles.filter((pair) => !pairs.has(pair));
        expect(newCycles).toEqual([]);
        expect(staleEntries).toEqual([]);
    });

    it('has no generic services folders', () => {
        const offenders: string[] = [];
        const scan = (dir: string, rel: string): void => {
            if (!existsSync(dir)) return;
            for (const entry of readdirSync(dir)) {
                if (entry.startsWith('.')) continue;
                if (entry === 'services') {
                    offenders.push(path.join(rel, entry));
                    continue;
                }
                const full = path.join(dir, entry);
                if (statSync(full).isDirectory()) scan(full, path.join(rel, entry));
            }
        };
        scan(sources, '.');
        expect(offenders).toEqual([]);
    });

    it('rejects nested ternaries in model folders and overlay', () => {
        const failures: string[] = [];
        for (const file of files) {
            const rel = path.relative(sources, file);
            const parts = rel.split(path.sep);
            const isModel = isFeature(parts[0]) && (parts[1] === 'domain' || parts[1] === 'model');
            if (!isModel && !rel.startsWith('encryption/')) continue;
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
});
