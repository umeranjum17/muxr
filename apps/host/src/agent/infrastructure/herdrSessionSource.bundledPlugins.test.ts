import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '@muxr/contract';
import { createHerdrSessionSource } from './herdrSessionSource.js';
import type { HerdrPlugin } from './pluginCatalog.js';

/**
 * Slice 1 of the session-surface decomposition: the host serves bundled-plugin
 * manifests from its own package. Herdr's registration is global to the
 * machine, so a host built from a branch must not project whichever release
 * last ran `muxr setup` — it remaps every registered bundled plugin id to its
 * packaged root before the catalog reads it. Herdr stays the authority on
 * registration and enabled state; only the root moves.
 *
 * This drives the real session source against a fake Herdr socket whose
 * registry points bundled ids at a stale "older installed release" tree, then
 * asserts the phone-facing projection (titles, RPC wiring) comes from this package's own plugins/ directory.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const packagedRoot = (id: string) => join(repoRoot, 'plugins', id.replace(/^muxr\./, ''));
const packagedManifest = (id: string) => JSON.parse(readFileSync(join(packagedRoot(id), 'muxr-ui.json'), 'utf8')) as {
    pluginId: string;
    capabilities?: Record<string, string>;
    contributions: Array<Record<string, unknown>>;
};

function stalePanesManifest(): Record<string, unknown> {
    const manifest = packagedManifest('muxr.panes') as unknown as Record<string, unknown>;
    const contributions = (manifest.contributions as Array<Record<string, unknown>>).map((contribution) => {
        if (contribution.slot === 'navigation.primary') return { ...contribution, label: 'STALE Panes' };
        if (contribution.slot === 'host.rpc' && contribution.id === 'list') return { ...contribution, entry: 'stale-panes.mjs' };
        return contribution;
    });
    return { ...manifest, contributions };
}

function pluginEntry(plugin: HerdrPlugin): HerdrPlugin {
    return plugin;
}

function fakeHerdr(dir: string, plugins: HerdrPlugin[]) {
    const server = createServer((socket: Socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method } = JSON.parse(line) as { id: string; method: string };
                let result: unknown;
                switch (method) {
                    case 'events.subscribe':
                        result = {};
                        break;
                    case 'session.snapshot':
                        result = { snapshot: { workspaces: [], tabs: [], panes: [], agents: [] } };
                        break;
                    case 'plugin.list':
                        result = { plugins };
                        break;
                    case 'workspace.list':
                        result = { workspaces: [] };
                        break;
                    default:
                        socket.end(`${JSON.stringify({ id, error: { code: 'method_not_found', message: method } })}\n`);
                        continue;
                }
                socket.end(`${JSON.stringify({ id, result })}\n`);
            }
        });
        socket.on('error', () => {});
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return { socketPath, close: () => server.close() };
}

describe('bundled plugins resolve to the host package', () => {
    it('projects packaged titles and RPC wiring when the global registry points at an older release', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-bundled-'));
        // The "older installed release": valid manifests with stale labels and
        // stale RPC wiring for ids this package also ships.
        const stalePanes = join(dir, 'old-release', 'panes');
        const extraRoot = join(dir, 'third-party', 'extra');
        for (const root of [stalePanes, extraRoot]) {
            mkdirSync(root, { recursive: true });
        }
        writeFileSync(join(stalePanes, 'muxr-ui.json'), JSON.stringify(stalePanesManifest()));
        const extraManifest = { schemaVersion: 1, pluginId: 'example.extra', contributions: [] };
        writeFileSync(join(extraRoot, 'muxr-ui.json'), JSON.stringify(extraManifest));

        const herdr = fakeHerdr(dir, [
            pluginEntry({ plugin_id: 'muxr.panes', name: 'Panes', version: '0.0.1', plugin_root: stalePanes, enabled: true }),
            pluginEntry({ plugin_id: 'example.extra', name: 'Extra', version: '1.0.0', plugin_root: extraRoot, enabled: true }),
            // Herdr stays the authority on enabled state: bundled but disabled here.
            pluginEntry({ plugin_id: 'muxr.voice', name: 'Voice', version: '0.0.1', plugin_root: join(dir, 'old-release', 'voice'), enabled: false }),
        ]);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            attachmentsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            await source.refreshPlugins?.();
            const list = await source.pluginList('test-device');
            const byId = new Map(list.map((summary) => [summary.pluginId, summary]));

            // Bundled id: the projected manifest is the packaged one, not the stale one.
            const panes = byId.get('muxr.panes');
            expect(panes).toBeDefined();
            const panesManifest = await source.pluginManifest({ pluginId: 'muxr.panes', manifestHash: panes!.manifestHash! });
            // The catalog projects the packaged manifest (normalized by the
            // real parser), never the stale registry copy.
            expect(panesManifest).toEqual(parseManifest(packagedManifest('muxr.panes')));
            // No bundled plugin contributes top-level navigation anymore: the
            // home is the screen and destinations live in cards, settings
            // rows, and sheets, never as tabs.
            const nav = panesManifest.contributions.find((contribution) => contribution.slot === 'navigation.primary');
            expect(nav).toBeUndefined();
            // RPC wiring resolves to the packaged script, not the stale entry.
            const rpc = panesManifest.contributions.find((contribution) => contribution.slot === 'host.rpc' && contribution.id === 'tools');
            expect(rpc).toMatchObject({ entry: 'panes.mjs' });
            for (const contribution of panesManifest.contributions) {
                if (contribution.slot !== 'host.rpc' && contribution.slot !== 'host.stream') continue;
                expect(existsSync(join(packagedRoot('muxr.panes'), (contribution as { entry: string }).entry))).toBe(true);
            }

            // Adversarial: a plugin this package does not ship keeps Herdr's root.
            const extra = byId.get('example.extra');
            expect(extra).toBeDefined();
            expect(await source.pluginManifest({ pluginId: 'example.extra', manifestHash: extra!.manifestHash! })).toEqual(extraManifest);

            // Adversarial: Herdr's disabled state stands even though a packaged root exists.
            expect(byId.has('muxr.voice')).toBe(false);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
