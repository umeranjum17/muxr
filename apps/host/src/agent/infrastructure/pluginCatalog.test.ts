import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pluginInvalidationFrame, PluginCatalog, PluginRefreshGate, WriteReplayFence, Semaphore, rpcReplayKey, runPluginProcess, type HerdrPlugin } from './pluginCatalog.js';
import { buildPluginPublicContext } from '../application/pluginPublicContext.js';
import { MAX_RPC_RESULT_STRING_BYTES, boundRpcDisplay, parseManifest, parsePluginAction, pluginCompatibilityError } from '@muxr/contract';

function plugin(root: string, actions: HerdrPlugin['actions'] = []): HerdrPlugin {
    return {
        plugin_id: 'example.muxr-ui', name: 'Example muxr UI', version: '0.1.0',
        plugin_root: root, enabled: true, actions, source: { kind: 'local' },
    };
}

describe('plugin catalog flow', () => {
    it('forces a read started after every freshness-critical caller', async () => {
        const releases: Array<() => void> = [];
        let reads = 0;
        const gate = new PluginRefreshGate(async () => {
            reads += 1;
            if (reads <= 2) await new Promise<void>((resolve) => { releases.push(resolve); });
        });
        const first = gate.poll();
        const queuedList = gate.forceFresh();
        expect(reads).toBe(1);
        releases.shift()!();
        await vi.waitFor(() => expect(reads).toBe(2));
        const callerDuringTrailingRead = gate.forceFresh();
        releases.shift()!();
        await Promise.all([first, queuedList, callerDuringTrailingRead]);
        expect(reads).toBe(3);
    });

    it('reconciles baseline, link, manifest change, enable/disable, and unlink once', () => {
        const snapshot = (entries: [string, string, boolean][]) => ({
            digests: new Map(entries.map(([id, digest]) => [id, digest])),
            enabled: new Map(entries.map(([id, , enabled]) => [id, enabled])),
        });
        const baseline = snapshot([]);
        expect(pluginInvalidationFrame(baseline, baseline)).toBeUndefined();
        const linked = snapshot([['demo', 'a', true]]);
        expect(pluginInvalidationFrame(baseline, linked)).toMatchObject({ reason: 'linked', pluginIds: ['demo'] });
        const changed = snapshot([['demo', 'b', true]]);
        expect(pluginInvalidationFrame(linked, changed)).toMatchObject({ reason: 'changed', pluginIds: ['demo'] });
        const disabled = snapshot([['demo', 'c', false]]);
        expect(pluginInvalidationFrame(changed, disabled)).toMatchObject({ reason: 'disabled', pluginIds: ['demo'] });
        const unlinked = snapshot([]);
        expect(pluginInvalidationFrame(disabled, unlinked)).toMatchObject({ reason: 'unlinked', pluginIds: ['demo'] });
        expect(pluginInvalidationFrame(unlinked, unlinked)).toBeUndefined();
        expect(pluginInvalidationFrame(baseline, snapshot([['bad id', 'x', true]]))).toMatchObject({ reason: 'linked', pluginIds: [] });
        const many = snapshot(Array.from({ length: 33 }, (_, index) => [`plugin.${String(index).padStart(2, '0')}`, 'x', true]));
        expect(pluginInvalidationFrame(baseline, many)).toMatchObject({ reason: 'linked', pluginIds: [] });
    });

    it('discovers a disabled capability provider and tracks when it becomes active', async () => {
        const root = await mkdtemp(join(tmpdir(), 'muxr-plugin-provider-'));
        await writeFile(join(root, 'muxr-ui.json'), JSON.stringify({
            schemaVersion: 1,
            pluginId: 'example.muxr-ui',
            capabilities: { 'voice.session': 'session' },
            contributions: [{ slot: 'host.stream', id: 'session', type: 'stream', entry: 'stream.mjs' }],
        }));
        const catalog = new PluginCatalog();
        await catalog.refresh([{ ...plugin(root), enabled: false }]);
        expect(catalog.list(() => true)).toEqual([]);
        expect(catalog.capabilityPlugins('voice.session')).toEqual([{
            pluginId: 'example.muxr-ui', name: 'Example muxr UI', enabled: false, source: { kind: 'local' }, hasBackend: true,
        }]);

        await catalog.refresh([plugin(root)]);
        expect(catalog.capabilityPlugins('voice.session')[0]).toMatchObject({ enabled: true });
    });

    it('allow-lists and bounds public RPC context without internal ids', async () => {
        const root = await mkdtemp(join(tmpdir(), 'muxr-plugin-context-'));
        const manifestPath = join(root, 'muxr-ui.json');
        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 1,
            pluginId: 'example.muxr-ui',
            contributions: [{ slot: 'host.rpc', id: 'read', type: 'rpc', method: 'read', entry: 'rpc.mjs', mode: 'read', context: ['sessions', 'workspace-tree'] }],
        }));
        const catalog = new PluginCatalog();
        await catalog.refresh([plugin(root)]);
        const loaded = catalog.list(() => true)[0]!;
        expect(catalog.call(loaded.pluginId, loaded.manifestHash!, 'read')).toEqual({
            method: 'read', entry: 'rpc.mjs', mode: 'read', modeDeclared: true, context: ['sessions', 'workspace-tree'],
        });

        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 1,
            pluginId: 'example.muxr-ui',
            contributions: [{ slot: 'host.rpc', id: 'read', type: 'rpc', method: 'read', entry: 'rpc.mjs', context: ['terminal-bytes'] }],
        }));
        await catalog.refresh([plugin(root)]);
        expect(catalog.list(() => false)[0]!.warnings[0]).toContain('unknown plugin RPC context');

        const context = buildPluginPublicContext(['sessions', 'workspace-tree'], {
            sessions: [{
                sessionId: 'pp_1234abcd', label: 'review', cwd: '/work/repo', workspaceLabel: 'repo', tabLabel: 'review',
                agentKind: 'pi', agentStatus: 'working', activeAt: '2026-08-15T12:00:00.000Z', paneId: 'w1:p1',
            } as never],
            attention: [{ sessionId: 'pp_1234abcd', reason: 'waiting', detail: 'answer needed', at: '2026-08-15T12:01:00.000Z', deviceId: 'secret' } as never],
            workspaces: [{
                label: 'repo', focused: true, agentStatus: 'working', workspaceId: 'w1',
                tabs: [{ label: 'review', focused: true, agentStatus: 'working', tabId: 'w1:t1', sessions: [{ sessionId: 'pp_1234abcd', label: 'review', agentKind: 'pi', agentStatus: 'working', paneId: 'w1:p1' }] } as never],
            } as never],
        }, 'pp_1234abcd');
        const serialized = JSON.stringify(context);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(48 * 1024);
        expect(serialized).toContain('pp_1234abcd');
        expect(serialized).not.toContain('w1:p1');
        expect(serialized).not.toContain('w1:t1');
        expect(serialized).not.toContain('"workspaceId"');
        expect(serialized).not.toContain('deviceId');
        expect(context.sessions?.[0]).toMatchObject({ sessionId: 'pp_1234abcd', label: 'review', agentStatus: 'working' });
        expect(context.workspaces?.[0]?.tabs[0]?.sessions[0]?.sessionId).toBe('pp_1234abcd');

        const capped = buildPluginPublicContext(['workspace-tree'], {
            sessions: [], attention: [],
            workspaces: [{
                label: 'repo', focused: true, agentStatus: 'working',
                tabs: Array.from({ length: 30 }, (_, index) => ({
                    label: `tab-${index}`, focused: false, agentStatus: 'idle',
                    sessions: [{ sessionId: index === 29 ? 'pp_1234abcd' : undefined, label: `session-${index}`, agentStatus: 'idle' }],
                })),
            }],
        }, 'pp_1234abcd');
        expect(capped.workspaces?.[0]?.tabs).toHaveLength(24);
        expect(capped.workspaces?.[0]?.tabs[0]?.sessions[0]?.sessionId).toBe('pp_1234abcd');
    });

    it('supports UI-only/backend-only/combined manifests and quarantines changes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'muxr-plugin-'));
        const manifestPath = join(root, 'muxr-ui.json');
        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [
                { slot: 'settings.sections', id: 'hello', title: 'Example', children: [{ type: 'row', title: 'It works' }, { type: 'future-widget' }] },
                { slot: 'future.slot', id: 'ignored' },
            ],
        }));

        const catalog = new PluginCatalog();
        await catalog.refresh([plugin(root)]);
        const first = catalog.list(() => false)[0];
        expect(first).toMatchObject({ pluginId: 'example.muxr-ui', approved: false, hasBackend: false });
        if (first?.manifestHash === undefined) throw new Error('plugin missing');
        const firstHash = first.manifestHash;
        expect(catalog.manifest(first.pluginId, firstHash).contributions).toHaveLength(1);

        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            capabilities: { 'preview.run-server': 'run' },
            contributions: [{ slot: 'session.toolbar', id: 'run', type: 'button', label: 'Run', action: { type: 'plugin.invoke', actionId: 'start' } }],
        }));
        await catalog.refresh([plugin(root, [{ id: 'start', command: ['node', 'start.mjs'] }])]);
        const changed = catalog.list(() => true)[0];
        expect(changed).toMatchObject({ approved: true, hasBackend: true, capabilities: { 'preview.run-server': 'run' } });
        if (changed?.manifestHash === undefined) throw new Error('changed plugin missing');
        expect(changed.manifestHash).not.toBe(firstHash);
        expect(() => catalog.manifest(first.pluginId, firstHash)).toThrow('unavailable or changed');
        expect(catalog.action(changed.pluginId, changed.manifestHash, 'run')).toBe('start');

        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            capabilities: { 'voice.token': 'token' },
            contributions: [{ slot: 'host.rpc', id: 'token', type: 'rpc', method: 'token', entry: 'rpc.mjs' }],
        }));
        await catalog.refresh([plugin(root)]);
        const rpc = catalog.list(() => true)[0]!;
        expect(catalog.call(rpc.pluginId, rpc.manifestHash!, 'token')).toEqual({ method: 'token', entry: 'rpc.mjs', mode: 'read', modeDeclared: false });

        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [
                { slot: 'home.cards', id: 'card', type: 'data-card', title: 'Usage', source: { type: 'plugin.call', contributionId: 'usage' } },
                { slot: 'host.rpc', id: 'usage', type: 'rpc', method: 'usage', entry: 'rpc.mjs' },
                { slot: 'terminal.key-row', id: 'keys', type: 'key-row', keys: [{ label: 'esc', accessibilityLabel: 'Escape', send: '\u001b' }] },
            ],
        }));
        await catalog.refresh([plugin(root)]);
        const declarative = catalog.list(() => true)[0]!;
        expect(catalog.manifest(declarative.pluginId, declarative.manifestHash!).contributions).toHaveLength(3);

        const backendRoot = join(root, 'backend-only');
        await mkdir(backendRoot);
        const backend = { ...plugin(backendRoot, [{ id: 'act', command: ['true'] }]), plugin_id: 'example.backend' };
        await catalog.refresh([backend]);
        const backendSummary = catalog.list(() => false)[0];
        expect(backendSummary).toMatchObject({ pluginId: 'example.backend', hasBackend: true });
        expect(backendSummary).not.toHaveProperty('manifestHash');

        const symlinkRoot = join(root, 'symlink');
        await mkdir(symlinkRoot);
        await symlink(manifestPath, join(symlinkRoot, 'muxr-ui.json'));
        await catalog.refresh([plugin(symlinkRoot)]);
        expect(catalog.list(() => false)[0]).toMatchObject({ pluginId: 'example.muxr-ui', hasBackend: false, warnings: [expect.stringContaining('rejected')] });
    });

    it('binds complete action authority and npm provenance into the host hash', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'muxr-plugin-')));
        await writeFile(join(root, 'muxr-ui.json'), JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [] }));
        const action = { id: 'start', command: ['node', 'start.mjs'], contexts: ['pane'], platforms: ['linux'], futureField: { v: 1 } };
        const catalog = new PluginCatalog();
        await catalog.refresh([plugin(root, [action])]);
        const first = catalog.list(() => true)[0]!;
        expect(first.manifestHash).toBeDefined();
        const firstHash = first.manifestHash;
        const changedAction = { ...action, contexts: ['workspace'] };
        await catalog.refresh([plugin(root, [changedAction])]);
        const changed = catalog.list(() => true)[0]!;
        expect(changed.manifestHash).not.toBe(firstHash);
        expect(() => catalog.action(changed.pluginId, changed.manifestHash!, 'missing')).toThrow('unavailable or changed');

        const muxrHome = await realpath(await mkdtemp(join(tmpdir(), 'muxr-home-')));
        const aliasParent = await realpath(await mkdtemp(join(tmpdir(), 'muxr-home-alias-')));
        const muxrHomeAlias = join(aliasParent, 'home');
        await symlink(muxrHome, muxrHomeAlias, 'dir');
        const extensionRoot = join(muxrHome, 'extensions');
        const managedRoot = join(extensionRoot, 'example.muxr-ui');
        await mkdir(managedRoot, { recursive: true });
        await writeFile(join(managedRoot, 'muxr-ui.json'), JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [] }));
        await mkdir(join(extensionRoot, '.provenance'));
        await writeFile(join(extensionRoot, '.provenance', 'example.muxr-ui.json'), JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', root: managedRoot, name: 'pkg', version: '1.0.0', integrity: 'sha512-abc' }));
        const previousHome = process.env.MUXR_HOME;
        process.env.MUXR_HOME = muxrHomeAlias;
        try {
            await catalog.refresh([plugin(managedRoot, [action])]);
            const npm = catalog.list(() => true)[0]!;
            expect(npm.source).toEqual({ kind: 'npm', name: 'pkg', version: '1.0.0', integrity: 'sha512-abc' });
            await writeFile(join(extensionRoot, '.provenance', 'example.muxr-ui.json'), JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', root: `${managedRoot}/.`, name: 'pkg', version: '1.0.0', integrity: 'sha512-abc' }));
            await catalog.refresh([plugin(managedRoot, [action])]);
            expect(catalog.list(() => true)[0]!.source).toEqual({ kind: 'local' });
            await writeFile(join(extensionRoot, '.provenance', 'example.muxr-ui.json'), JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', root: managedRoot, name: 'pkg', version: '2.0.0', integrity: 'sha512-def' }));
            await catalog.refresh([plugin(managedRoot, [action])]);
            const rotated = catalog.list(() => true)[0]!;
            expect(rotated.manifestHash).not.toBe(npm.manifestHash);
        } finally {
            if (previousHome === undefined) delete process.env.MUXR_HOME; else process.env.MUXR_HOME = previousHome;
        }
    });

    it('parses declarative screens, enforces node/depth/reference limits, and rotates the hash on raw unknown fields', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'muxr-plugin-')));
        const manifestPath = join(root, 'muxr-ui.json');
        const manifest = (screen: unknown, rpcMode = 'read') => ({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [
                { slot: 'host.rpc', id: 'list-rpc', type: 'rpc', method: 'list', entry: 'rpc.mjs', mode: rpcMode },
                { slot: 'host.rpc', id: 'save-rpc', type: 'rpc', method: 'save', entry: 'rpc.mjs', mode: 'write' },
                { slot: 'navigation.primary', id: 'nav', type: 'navigation-item', label: 'Example', icon: 'albums-outline', contentContributionId: 'main' },
                { slot: 'navigation.content', id: 'main', type: 'screen', title: 'Example', data: { type: 'plugin.call', contributionId: 'list-rpc' }, children: screen },
            ],
        });
        const catalog = new PluginCatalog();

        // Every vocabulary node parses; unknown node types are skipped without
        // blanking valid siblings; a known node with bad fields rejects the UI.
        await writeFile(manifestPath, JSON.stringify(manifest([
            { type: 'text', text: 'Hello {{data.title}}', tone: 'positive' },
            { type: 'row', title: 'Row', subtitle: 'Sub', value: '{{data.count}}' },
            { type: 'metric', label: 'Usage', value: '42%' },
            { type: 'badge', label: 'beta', tone: 'warning' },
            { type: 'progress', value: 30, max: 100 },
            { type: 'divider' },
            { type: 'empty', title: 'Nothing here', message: 'Yet' },
            { type: 'future-node', payload: { nested: true } },
            { type: 'section', title: 'Form', children: [
                { type: 'field', kind: 'text', id: 'name', label: 'Name', placeholder: 'Ada', value: 'Ada' },
                { type: 'field', kind: 'switch', id: 'on', label: 'On', value: 'true' },
                { type: 'field', kind: 'select', id: 'tier', label: 'Tier', options: ['free', 'pro'], value: 'pro' },
                { type: 'button', label: 'Save', action: { type: 'plugin.call', contributionId: 'save-rpc' }, fields: ['name', 'on', 'tier'], variant: 'primary' },
            ] },
            { type: 'list', title: 'Recent', emptyText: 'Empty', rows: [{ type: 'row', title: 'A', value: '1' }, { type: 'row', title: 'B' }] },
        ])));
        await catalog.refresh([plugin(root)]);
        const loaded = catalog.list(() => true)[0]!;
        const screen = catalog.manifest(loaded.pluginId, loaded.manifestHash!).contributions
            .find((contribution): contribution is import('@muxr/contract').PluginScreenContribution =>
                'type' in contribution && contribution.type === 'screen')!;
        expect(screen.children.map((node) => node.type)).toEqual([
            'text', 'row', 'metric', 'badge', 'progress', 'divider', 'empty', 'section', 'list',
        ]);
        const section = screen.children.find((node) => node.type === 'section');
        if (section?.type !== 'section') throw new Error('section missing');
        expect(section.children.map((node) => node.type)).toEqual(['field', 'field', 'field', 'button']);
        expect(catalog.call(loaded.pluginId, loaded.manifestHash!, 'save-rpc')).toEqual({ method: 'save', entry: 'rpc.mjs', mode: 'write', modeDeclared: true });
        expect(catalog.call(loaded.pluginId, loaded.manifestHash!, 'list-rpc')).toEqual({ method: 'list', entry: 'rpc.mjs', mode: 'read', modeDeclared: true });
        expect(catalog.callTarget(loaded.pluginId, loaded.manifestHash!, 'list-rpc')).toEqual({ method: 'list', entry: 'rpc.mjs', mode: 'read', modeDeclared: true, pluginRoot: root });

        // Unknown fields in the raw manifest rotate the approval hash even when
        // the validated projection is byte-identical.
        const before = loaded.manifestHash!;
        const projection = JSON.stringify(catalog.manifest(loaded.pluginId, loaded.manifestHash!));
        await writeFile(manifestPath, JSON.stringify({
            ...manifest([
                { type: 'text', text: 'Hello {{data.title}}', tone: 'positive' },
                { type: 'row', title: 'Row', subtitle: 'Sub', value: '{{data.count}}' },
                { type: 'metric', label: 'Usage', value: '42%' },
                { type: 'badge', label: 'beta', tone: 'warning' },
                { type: 'progress', value: 30, max: 100 },
                { type: 'divider' },
                { type: 'empty', title: 'Nothing here', message: 'Yet' },
                { type: 'future-node', payload: { nested: true } },
                { type: 'section', title: 'Form', children: [
                    { type: 'field', kind: 'text', id: 'name', label: 'Name', placeholder: 'Ada', value: 'Ada' },
                    { type: 'field', kind: 'switch', id: 'on', label: 'On', value: 'true' },
                    { type: 'field', kind: 'select', id: 'tier', label: 'Tier', options: ['free', 'pro'], value: 'pro' },
                    { type: 'button', label: 'Save', action: { type: 'plugin.call', contributionId: 'save-rpc' }, fields: ['name', 'on', 'tier'], variant: 'primary' },
                ] },
                { type: 'list', title: 'Recent', emptyText: 'Empty', rows: [{ type: 'row', title: 'A', value: '1' }, { type: 'row', title: 'B' }] },
            ]),
            futureField: { anything: 'at all' },
        }));
        await catalog.refresh([plugin(root)]);
        const rotated = catalog.list(() => true)[0]!;
        expect(rotated.manifestHash).not.toBe(before);
        expect(JSON.stringify(catalog.manifest(rotated.pluginId, rotated.manifestHash!))).toBe(projection);

        // Node cap: 65 nodes reject the UI.
        const sixtyFive = Array.from({ length: 65 }, (_, index) => ({ type: 'row', title: `row-${index}` }));
        await writeFile(manifestPath, JSON.stringify(manifest(sixtyFive)));
        await catalog.refresh([plugin(root)]);
        expect(catalog.list(() => false)[0]!.warnings[0]).toContain('too many plugin screen nodes');

        // List rows are rendered children and count toward the same budget:
        // one list with 32 rows (33) plus 32 top-level rows is 65 total.
        await writeFile(manifestPath, JSON.stringify(manifest([
            { type: 'list', title: 'Recent', rows: Array.from({ length: 32 }, (_, index) => ({ type: 'row', title: `r${index}` })) },
            ...Array.from({ length: 32 }, (_, index) => ({ type: 'row', title: `top-${index}` })),
        ])));
        await catalog.refresh([plugin(root)]);
        expect(catalog.list(() => false)[0]!.warnings[0]).toContain('too many plugin screen nodes');

        // Depth cap: a section under a section under a section under a section
        // (depth 5) rejects.
        let deep: unknown = { type: 'row', title: 'leaf' };
        for (let index = 0; index < 4; index += 1) deep = { type: 'section', title: `s${index}`, children: [deep] };
        await writeFile(manifestPath, JSON.stringify(manifest([deep])));
        await catalog.refresh([plugin(root)]);
        expect(catalog.list(() => false)[0]!.warnings[0]).toContain('nesting is too deep');

        // Screen data RPC must be read mode.
        await writeFile(manifestPath, JSON.stringify(manifest([{ type: 'text', text: 'x' }], 'write')));
        await catalog.refresh([plugin(root)]);
        expect(catalog.list(() => false)[0]!.warnings[0]).toContain('must be read mode');

        // Button referencing an undeclared RPC rejects.
        await writeFile(manifestPath, JSON.stringify(manifest([{ type: 'button', label: 'Go', action: { type: 'plugin.call', contributionId: 'missing' } }])));
        await catalog.refresh([plugin(root)]);
        expect(catalog.list(() => false)[0]!.warnings[0]).toContain('screen action RPC is not declared: missing');

        // RPC transport strings share the 64 KiB stdout ceiling, are sanitized,
        // depth-capped (no raw subtrees), prototype-safe, and arrays bounded.
        // Ordinary text renderers apply the smaller 4 KiB display cap; the
        // public code node can consume this larger bounded value.
        const long = 'x'.repeat(MAX_RPC_RESULT_STRING_BYTES + 1000);
        const emoji = '😀'.repeat(MAX_RPC_RESULT_STRING_BYTES / 4 + 100); // 4 bytes per code point
        const bounded = boundRpcDisplay({ text: long, emoji, list: [long, { nested: long }], keep: 42, 'constructor': { ok: true }, deep: { deep: { deep: { deep: { deep: { deep: { deep: { deep: { deep: long } } } } } } } } }) as any;
        expect(bounded.text).toHaveLength(MAX_RPC_RESULT_STRING_BYTES);
        expect(Buffer.byteLength(bounded.emoji, 'utf8')).toBe(MAX_RPC_RESULT_STRING_BYTES); // byte cap, not char cap
        expect(bounded.list[1].nested).toHaveLength(MAX_RPC_RESULT_STRING_BYTES);
        expect(bounded.keep).toBe(42);
        expect(bounded['constructor'].ok).toBe(true); // plugin-chosen key stays plain data
        expect(Object.getPrototypeOf(bounded)).toBe(null);
        // A subtree past the depth cap is dropped, never returned raw.
        let deepTree: unknown = { text: long };
        for (let i = 0; i < 9; i += 1) deepTree = { deep: deepTree };
        const boundedDeep = boundRpcDisplay({ deep: deepTree }) as any;
        expect(JSON.stringify(boundedDeep.deep)).not.toContain(long);
        expect(JSON.stringify(boundedDeep.deep).length).toBeLessThan(100);
        expect((boundRpcDisplay({ dirty: 'a\u0000b\u202Ec\u200Bd' }) as any).dirty).toBe('abcd');
        expect((boundRpcDisplay(Array.from({ length: 500 }, (_, i) => i)) as unknown[]).length).toBe(256);
        // JSON null is preserved (a null result stays a successful null, and
        // nulls survive inside arrays/objects).
        expect(boundRpcDisplay(null)).toBe(null);
        expect((boundRpcDisplay({ list: [null, { nested: null }] }) as any).list).toEqual([null, { nested: null }]);

        // Replay keys exclude the input; the input fingerprint lives in the fence.
        expect(rpcReplayKey('dev', 'ext', 'hash', 'c', 'k')).toBe(rpcReplayKey('dev', 'ext', 'hash', 'c', 'k'));
        expect(rpcReplayKey('dev', 'ext', 'hash', 'c', 'k')).not.toBe(rpcReplayKey('dev', 'ext', 'hash', 'c', 'k2'));
    });

    it('replay fence: replays identical key+input, rejects different input, drops rejections, and is bounded', async () => {
        const fence = new WriteReplayFence();
        let executions = 0;
        const run = (outcome: 'ok' | 'fail'): Promise<unknown> => {
            executions += 1;
            return outcome === 'ok' ? Promise.resolve('done') : Promise.reject(new Error('boom'));
        };

        // Same key + same input replays the recorded outcome without re-running.
        const first = fence.run('device-a\0plugin-a', 'k', 'digest-a', () => run('ok'));
        expect(fence.run('device-a\0plugin-a', 'k', 'digest-a', () => run('ok'))).toBe(first);
        await expect(first).resolves.toBe('done');
        expect(executions).toBe(1);

        // Same key + different input rejects instead of running twice.
        expect(() => fence.run('device-a\0plugin-a', 'k', 'digest-b', () => run('ok'))).toThrow('different input');
        expect(executions).toBe(1);

        // A rejected write is dropped, so a retry with the same key re-executes.
        const failing = fence.run('device-a\0plugin-a', 'k2', 'digest-a', () => run('fail'));
        await expect(failing).rejects.toThrow('boom');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const retry = fence.run('device-a\0plugin-a', 'k2', 'digest-a', () => run('ok'));
        await expect(retry).resolves.toBe('done');
        expect(executions).toBe(3);

        // Every successful outcome occupies its slot for the full TTL. A 65th
        // distinct write is rejected before its executable work starts, while
        // an old key still replays without a second execution.
        const boundedFence = new WriteReplayFence();
        let boundedExecutions = 0;
        const scope = 'device-a\0plugin-a';
        for (let index = 0; index < 64; index += 1) {
            await boundedFence.run(scope, `p${index}`, `d${index}`, async () => {
                boundedExecutions += 1;
                return index;
            });
        }
        expect(boundedFence.size(scope)).toBe(64);
        expect(() => boundedFence.run(scope, 'p65', 'd65', async () => {
            boundedExecutions += 1;
            return 'untracked';
        })).toThrow('too many plugin writes');
        expect(boundedExecutions).toBe(64);
        await expect(boundedFence.run(scope, 'p0', 'd0', async () => {
            boundedExecutions += 1;
            return 'executed twice';
        })).resolves.toBe(0);
        // A different device+plugin shard remains available.
        await expect(boundedFence.run('device-b\0plugin-a', 'fresh', 'fresh-digest', async () => 'isolated')).resolves.toBe('isolated');
        expect(boundedExecutions).toBe(64);
    });

    it('binds local approval hashes to the canonical executable root without exposing it in the summary', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'muxr-plugin-source-'));
        const firstRoot = join(parent, 'first');
        const secondRoot = join(parent, 'second');
        await mkdir(firstRoot);
        await mkdir(secondRoot);
        const manifest = JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [] });
        await writeFile(join(firstRoot, 'muxr-ui.json'), manifest);
        await writeFile(join(secondRoot, 'muxr-ui.json'), manifest);
        const catalog = new PluginCatalog();
        await catalog.refresh([plugin(firstRoot)]);
        const first = catalog.list(() => true)[0]!;
        const approvedHashes = new Set([first.manifestHash]);
        expect(first.source).toEqual({ kind: 'local' });
        expect(first.source).not.toHaveProperty('root');
        expect(first.approved).toBe(true);

        await catalog.refresh([plugin(secondRoot)]);
        const relinked = catalog.list((_, hash) => approvedHashes.has(hash))[0]!;
        expect(relinked.source).toEqual({ kind: 'local' });
        expect(relinked.manifestHash).not.toBe(first.manifestHash);
        expect(relinked.approved).toBe(false);
    });

    it('keeps stable hashes across cosmetic changes and rotates on declaration changes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'muxr-plugin-stable-'));
        await writeFile(join(root, 'muxr-ui.json'), JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [] }));
        const catalog = new PluginCatalog();
        await catalog.refresh([plugin(root)]);
        const approved = catalog.list(() => true)[0]!.manifestHash;

        // A rename, a new description and a version bump grant no authority,
        // so a paired device must not silently lose the plugin.
        await catalog.refresh([{ ...plugin(root), name: 'Renamed', version: '9.9.9', description: 'reworded' }]);
        expect(catalog.list((_, hash) => hash === approved)[0]!.approved).toBe(true);

        // Declaring another surface is a real change and rotates the authority hash.
        await writeFile(join(root, 'muxr-ui.json'), JSON.stringify({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [{ slot: 'settings.sections', id: 's', type: 'section', title: 'T', children: [] }],
        }));
        await catalog.refresh([plugin(root)]);
        const stale = catalog.list((_, hash) => hash === approved)[0]!;
        expect(stale.approved).toBe(false);
        expect(stale.manifestHash).not.toBe(approved);
        expect(stale).not.toHaveProperty('changed');
    });

    it('binds GitHub approval hashes to the canonical root without exposing it in the summary', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'muxr-plugin-github-'));
        const firstRoot = join(parent, 'first');
        const secondRoot = join(parent, 'second');
        await mkdir(firstRoot);
        await mkdir(secondRoot);
        const manifest = JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [] });
        await writeFile(join(firstRoot, 'muxr-ui.json'), manifest);
        await writeFile(join(secondRoot, 'muxr-ui.json'), manifest);
        const source = { kind: 'github' as const, owner: 'muxr', repo: 'example', resolved_commit: 'a'.repeat(40) };
        const expectedSource = { kind: 'github' as const, owner: 'muxr', repo: 'example', resolvedCommit: source.resolved_commit };
        const catalog = new PluginCatalog();
        await catalog.refresh([{ ...plugin(firstRoot), source }]);
        const first = catalog.list(() => true)[0]!;
        expect(first.source).toEqual(expectedSource);
        expect(first.source).not.toHaveProperty('root');

        await catalog.refresh([{ ...plugin(secondRoot), source }]);
        const relinked = catalog.list((_, hash) => hash === first.manifestHash)[0]!;
        expect(relinked.manifestHash).not.toBe(first.manifestHash);
        expect(relinked.approved).toBe(false);
    });

    it('quarantines one non-finite registry authority without freezing valid plugins', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'muxr-plugin-registry-number-'));
        const validRoot = join(parent, 'valid');
        const badRoot = join(parent, 'bad');
        await mkdir(validRoot);
        await mkdir(badRoot);
        const manifest = JSON.stringify({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [] });
        await writeFile(join(validRoot, 'muxr-ui.json'), manifest);
        await writeFile(join(badRoot, 'muxr-ui.json'), manifest.replaceAll('example.muxr-ui', 'example.bad-muxr-ui'));
        const bad = { ...plugin(badRoot, [{ id: 'bad', command: ['true'], malformed: Infinity }]), plugin_id: 'example.bad-muxr-ui' };
        const catalog = new PluginCatalog();
        const digests = await catalog.refresh([bad, plugin(validRoot)]);
        expect(digests.get('example.bad-muxr-ui')).toBeDefined();
        expect(digests.get('example.muxr-ui')).toBeDefined();
        const summaries = catalog.list(() => true);
        expect(summaries.map(({ pluginId }) => pluginId)).toEqual(['example.bad-muxr-ui', 'example.muxr-ui']);
        expect(summaries[0]).toMatchObject({ pluginId: 'example.bad-muxr-ui', warnings: [expect.stringContaining('authority number')] });
        expect(summaries[0]).not.toHaveProperty('manifestHash');
        expect(summaries[1]).toHaveProperty('manifestHash');

        const finite = { ...bad, actions: [{ id: 'bad', command: ['true'], malformed: null }] };
        const finiteDigests = await catalog.refresh([finite]);
        expect(finiteDigests.get('example.bad-muxr-ui')).not.toBe(digests.get('example.bad-muxr-ui'));
    });

    it('rejects non-finite values in unknown raw manifest fields before host hashing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'muxr-plugin-manifest-number-'));
        const manifestPath = join(root, 'muxr-ui.json');
        await writeFile(manifestPath, '{"schemaVersion":1,"pluginId":"example.muxr-ui","contributions":[],"future":null}');
        const catalog = new PluginCatalog();
        await catalog.refresh([plugin(root)]);
        const valid = catalog.list(() => true)[0]!;
        expect(valid.manifestHash).toBeDefined();

        const overflow = JSON.parse('{"schemaVersion":1,"pluginId":"example.muxr-ui","contributions":[],"future":1e400}');
        expect(overflow.future).toBe(Infinity);
        expect(() => parseManifest(overflow)).toThrow('manifest number');
        await writeFile(manifestPath, '{"schemaVersion":1,"pluginId":"example.muxr-ui","contributions":[],"future":1e400}');
        await catalog.refresh([plugin(root)]);
        const rejected = catalog.list(() => true)[0]!;
        expect(rejected).not.toHaveProperty('manifestHash');
        expect(rejected.warnings[0]).toContain('manifest number');
    });

    it('pins a symlink-root snapshot across retargeting and rotates approval on refresh', async () => {
        const parent = await realpath(await mkdtemp(join(tmpdir(), 'muxr-plugin-symlink-root-')));
        const firstRoot = join(parent, 'first');
        const secondRoot = join(parent, 'second');
        const linkRoot = join(parent, 'current');
        await mkdir(firstRoot);
        await mkdir(secondRoot);
        const manifest = { schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [{ slot: 'host.rpc', id: 'read', type: 'rpc', method: 'read', entry: 'rpc.mjs' }] };
        await writeFile(join(firstRoot, 'muxr-ui.json'), JSON.stringify(manifest));
        await writeFile(join(secondRoot, 'muxr-ui.json'), JSON.stringify(manifest));
        await symlink(firstRoot, linkRoot, 'dir');
        const catalog = new PluginCatalog();
        await catalog.refresh([plugin(linkRoot)]);
        const firstHash = catalog.list(() => true)[0]!.manifestHash!;
        const approved = new Set([firstHash]);
        expect(catalog.list((_, hash) => approved.has(hash))[0]!.approved).toBe(true);

        await rm(linkRoot);
        await symlink(secondRoot, linkRoot, 'dir');
        expect(catalog.callTarget('example.muxr-ui', firstHash, 'read').pluginRoot).toBe(firstRoot);

        await catalog.refresh([plugin(linkRoot)]);
        const second = catalog.list((_, hash) => approved.has(hash))[0]!;
        expect(second.manifestHash).not.toBe(firstHash);
        expect(second.approved).toBe(false);
        expect(catalog.callTarget('example.muxr-ui', second.manifestHash!, 'read').pluginRoot).toBe(secondRoot);
    });

    it('binds RPC target root to the validated hash snapshot', async () => {
        const parent = await realpath(await mkdtemp(join(tmpdir(), 'muxr-plugin-target-')));
        const oldRoot = join(parent, 'old');
        const newRoot = join(parent, 'new');
        await mkdir(oldRoot);
        await mkdir(newRoot);
        const manifest = { schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [{ slot: 'host.rpc', id: 'read', type: 'rpc', method: 'read', entry: 'rpc.mjs' }] };
        await writeFile(join(oldRoot, 'muxr-ui.json'), JSON.stringify(manifest));
        await writeFile(join(newRoot, 'muxr-ui.json'), JSON.stringify({ ...manifest, future: 'new-root' }));
        const catalog = new PluginCatalog();
        await catalog.refresh([plugin(oldRoot)]);
        const oldHash = catalog.list(() => true)[0]!.manifestHash!;
        expect(catalog.callTarget('example.muxr-ui', oldHash, 'read').pluginRoot).toBe(oldRoot);
        await catalog.refresh([plugin(newRoot)]);
        const newHash = catalog.list(() => true)[0]!.manifestHash!;
        expect(newHash).not.toBe(oldHash);
        expect(() => catalog.callTarget('example.muxr-ui', oldHash, 'read')).toThrow('unavailable or changed');
        expect(catalog.callTarget('example.muxr-ui', newHash, 'read').pluginRoot).toBe(newRoot);
    });

    it('passes RPC input on stdin, never through the child environment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'muxr-plugin-stdin-'));
        const stateDir = join(root, 'state');
        const script = join(root, 'rpc.mjs');
        await mkdir(stateDir);
        await writeFile(script, `
            import { readFileSync } from 'node:fs';
            process.stdout.write(JSON.stringify({ input: JSON.parse(readFileSync(0, 'utf8')), leaked: process.env.MUXR_PLUGIN_INPUT !== undefined }));
        `);
        await expect(runPluginProcess({
            pluginId: 'example.stdin', method: 'read', script,
            serializedInput: '{"secret":"stdin-only"}', stateDir,
        })).resolves.toEqual({ input: { secret: 'stdin-only' }, leaked: false });
    });

    it('kills a hung process group and releases its semaphore slot before inherited pipes close', async () => {
        if (process.platform === 'win32') return;
        const root = await mkdtemp(join(tmpdir(), 'muxr-plugin-process-'));
        const stateDir = join(root, 'state');
        const pidFile = join(root, 'grandchild.pid');
        const grandchild = join(root, 'grandchild.mjs');
        const parent = join(root, 'rpc.mjs');
        await mkdir(stateDir);
        await writeFile(grandchild, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
        await writeFile(parent, `
            import { spawn } from 'node:child_process';
            import { writeFileSync } from 'node:fs';
            const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] });
            writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
            setInterval(() => {}, 1000);
        `);
        const semaphore = new Semaphore(1);
        const started = Date.now();
        await expect(semaphore.run(() => runPluginProcess({
            pluginId: 'example.hung', method: 'hang', script: parent,
            serializedInput: 'null', stateDir, deadlineMs: 250, killGraceMs: 100,
        }))).rejects.toThrow('exceeded 250ms');
        expect(Date.now() - started).toBeLessThan(1_500);
        await expect(semaphore.run(async () => 'released')).resolves.toBe('released');
        const descendantPid = Number(await readFile(pidFile, 'utf8'));
        await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow(), { timeout: 2_000 });
    });

    it('semaphore caps concurrency and drops timed-out waiters before they can run', async () => {
        const semaphore = new Semaphore(2);
        let active = 0;
        let peak = 0;
        const task = async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
        };
        await Promise.all(Array.from({ length: 8 }, () => semaphore.run(task)));
        expect(peak).toBe(2);

        const one = new Semaphore(1);
        let release!: () => void;
        const held = one.run(() => new Promise<void>((resolve) => { release = resolve; }));
        let lateRan = false;
        await expect(one.run(async () => { lateRan = true; }, 5)).rejects.toMatchObject({ name: 'PluginCallQueueTimeoutError' });
        release();
        await held;
        expect(lateRan).toBe(false);
        await expect(one.run(async () => 'available')).resolves.toBe('available');
    });

    it('shared manifest parser rejects duplicate contribution ids, duplicate screen field ids, and write-mode data cards', async () => {
        const base = {
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [
                { slot: 'host.rpc', id: 'r', type: 'rpc', method: 'm', entry: 'rpc.mjs' },
                { slot: 'home.cards', id: 'card', type: 'data-card', title: 'Card', source: { type: 'plugin.call', contributionId: 'r' }, emptyText: 'none' },
            ],
        };
        expect(() => parseManifest(base)).not.toThrow();
        expect(() => parseManifest({
            ...base,
            contributions: [
                ...base.contributions,
                { slot: 'host.rpc', id: 'r', type: 'rpc', method: 'm2', entry: 'rpc.mjs' },
            ],
        })).toThrow('duplicate plugin contribution id');
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [
                { slot: 'host.rpc', id: 'r', type: 'rpc', method: 'm', entry: 'rpc.mjs' },
                { slot: 'navigation.content', id: 's', type: 'screen', children: [
                    { type: 'field', kind: 'text', id: 'f', label: 'A' },
                    { type: 'field', kind: 'text', id: 'f', label: 'B' },
                ] },
            ],
        })).toThrow('duplicate plugin screen field id');
        expect(() => parseManifest({
            ...base,
            contributions: [
                { slot: 'host.rpc', id: 'w', type: 'rpc', method: 'm', entry: 'rpc.mjs', mode: 'write' },
                { slot: 'home.cards', id: 'card', type: 'data-card', title: 'Card', source: { type: 'plugin.call', contributionId: 'w' } },
            ],
        })).toThrow('data card source must be read mode');

        // Native primitives attach only where their declared context exists,
        // and required/forbidden parameters fail during author validation.
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'terminal.key-row', id: 'wrong', type: 'native', primitive: 'collection', params: { source: { type: 'plugin.call', contributionId: 'read' } } },
        ] })).toThrow('plugin primitive collection is not available in slot terminal.key-row');
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'session.pills', id: 'files', type: 'native', primitive: 'item-list' },
        ] })).toThrow('plugin primitive item-list requires source');
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'navigation.content', id: 'feed', type: 'native', primitive: 'collection', params: { source: { type: 'plugin.call', contributionId: 'read' }, capability: 'extra' } },
        ] })).toThrow('unknown parameter capability for plugin primitive collection');
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'session.pills', id: 'legacy', type: 'native', primitive: 'item-list', source: { type: 'plugin.call', contributionId: 'read' } },
        ] })).toThrow('parameters must be under params');
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'home.composer.leading', id: 'missing-presentation', type: 'native', primitive: 'icon-button', params: { capability: 'voice.start' } },
        ] })).toThrow('plugin primitive icon-button requires icon');
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'home.composer.leading', id: 'bad-indicator', type: 'native', primitive: 'icon-button', params: { capability: 'voice.start', icon: 'radio-outline', accessibilityLabel: 'Start', indicator: 'voice' } },
        ] })).toThrow('invalid indicator for plugin primitive icon-button');
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'home.composer.trailing', id: 'home', type: 'native', primitive: 'dictate' },
            { slot: 'session.composer.trailing', id: 'session', type: 'native', primitive: 'dictate' },
            { slot: 'session.header.trailing', id: 'voice', type: 'native', primitive: 'icon-button', params: { capability: 'voice.start', icon: 'radio-outline', accessibilityLabel: 'Start realtime' } },
            { slot: 'host.rpc', id: 'read', type: 'rpc', method: 'read', entry: 'rpc.mjs' },
            { slot: 'home.cards', id: 'items', type: 'native', primitive: 'item-list', params: { source: { type: 'plugin.call', contributionId: 'read' }, icon: 'globe-outline', accessibilityLabel: 'Open servers', refreshIntervalMs: 15000 } },
            { slot: 'navigation.content', id: 'collection', type: 'native', primitive: 'collection', params: { source: { type: 'plugin.call', contributionId: 'read' }, title: 'Items', emptyTitle: 'None', emptyMessage: 'Nothing yet', icon: 'albums-outline' } },
            { slot: 'session.overlay', id: 'tree', type: 'native', primitive: 'tree-sheet', params: { source: { type: 'plugin.call', contributionId: 'read' }, title: 'Tree' } },
        ] })).not.toThrow();
        for (const refreshIntervalMs of [4999, 300001, 1.5]) {
            expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
                { slot: 'host.rpc', id: 'read', type: 'rpc', method: 'read', entry: 'rpc.mjs' },
                { slot: 'session.header.trailing', id: 'items', type: 'native', primitive: 'item-list', params: { source: { type: 'plugin.call', contributionId: 'read' }, refreshIntervalMs } },
            ] })).toThrow('invalid refreshIntervalMs for plugin primitive item-list');
        }
        expect(parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'session.header.trailing', id: 'legacy', type: 'native', primitive: 'url-chip' },
        ] }).contributions).toEqual([]);
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'terminal.key-row', id: 'keys', type: 'key-row', keys: [
                { label: 'enter', accessibilityLabel: 'Enter', send: '\r' },
                { label: 'left', accessibilityLabel: 'Left', send: '\u001b[D' },
            ] },
        ] })).not.toThrow();
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'terminal.key-row', id: 'keys', type: 'key-row', keys: [
                { label: 'enter', accessibilityLabel: 'Enter', send: 'rm -rf /\r' },
            ] },
        ] })).toThrow('invalid terminal key sequence');

        // Settings rows use the same closed action contract; screen targets
        // remain scoped to the same parsed manifest.
        const withSettings = parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', minMuxrVersion: 7, contributions: [
            { slot: 'navigation.content', id: 'settings-screen', type: 'screen', title: 'Settings', children: [{ type: 'text', text: 'Ready' }] },
            { slot: 'settings.items', id: 'settings', type: 'settings-item', label: 'Example', icon: 'settings-outline', action: { type: 'screen', contributionId: 'settings-screen' } },
        ] });
        expect(withSettings.minMuxrVersion).toBe(7);
        expect(pluginCompatibilityError(withSettings, 1)).toContain('requires muxr UI 7');
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'settings.items', id: 'settings', type: 'settings-item', label: 'Example', icon: 'settings-outline', action: { type: 'screen', contributionId: 'missing' } },
        ] })).toThrow('settings item action targets an unknown screen');

        expect(parsePluginAction({ type: 'open-url', url: 'https://example.com/path' })).toEqual({ type: 'open-url', url: 'https://example.com/path' });
        expect(parsePluginAction({ type: 'kernel.navigate', target: 'file', path: 'src/app.ts' })).toEqual({ type: 'kernel.navigate', target: 'file', path: 'src/app.ts' });
        expect(parsePluginAction({ type: 'kernel.navigate', target: 'preview', port: 3000 })).toEqual({ type: 'kernel.navigate', target: 'preview', port: 3000 });
        for (const port of [0, 65536, 1.5, '3000']) expect(() => parsePluginAction({ type: 'kernel.navigate', target: 'preview', port })).toThrow('invalid plugin preview port');
        expect(() => parsePluginAction({ type: 'open-url', url: 'file:///etc/passwd' })).toThrow('must be HTTPS');
        expect(() => parsePluginAction({ type: 'kernel.navigate', target: 'file', path: 'file:///etc/passwd' })).toThrow('filesystem path');
        expect(() => parsePluginAction({ type: 'kernel.navigate', target: 'unknown' })).toThrow('unknown plugin navigation target');
        expect(() => parsePluginAction({ type: 'future-action' })).toThrow('unknown plugin action');
        expect(() => parsePluginAction({ type: 'kernel.navigate', target: 'file', path: 'x'.repeat(1025) })).toThrow('invalid plugin action path');
        expect(() => parsePluginAction({ type: 'secure-prompt', title: 'Key', message: 'Secret', inputKey: 'key', submit: { type: 'capability', name: 'not-a-call' } })).toThrow('secure prompt must submit to plugin.call');
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'host.rpc', id: 'set', type: 'rpc', method: 'set', entry: 'rpc.mjs', mode: 'write' },
            { slot: 'navigation.content', id: 'settings', type: 'screen', children: [
                { type: 'button', label: 'Set', action: { type: 'secure-prompt', title: 'Key', message: 'Sent once', inputKey: 'key', submit: { type: 'plugin.call', contributionId: 'set' } } },
                { type: 'button', label: 'Clear', action: { type: 'confirm', title: 'Clear?', message: 'Deletes it', confirmLabel: 'Clear', destructive: true, action: { type: 'plugin.call', contributionId: 'set' } } },
            ] },
        ] })).not.toThrow();
        expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
            { slot: 'host.rpc', id: 'read', type: 'rpc', method: 'read', entry: 'rpc.mjs', mode: 'read' },
            { slot: 'settings.items', id: 'bad', type: 'settings-item', label: 'Bad', icon: 'key-outline', action: { type: 'secure-prompt', title: 'Key', message: 'Sent once', inputKey: 'key', submit: { type: 'plugin.call', contributionId: 'read' } } },
        ] })).toThrow('secure-prompt RPC must be write mode');

        for (const slot of ['events', 'shortcuts'] as const) {
            const contribution = slot === 'events'
                ? { slot, id: 'react', on: 'agent.status', from: 'working', to: ['idle'], action: { type: 'plugin.call', contributionId: 'write' } }
                : { slot, id: 'shortcut', label: 'Example', synonyms: ['example'], action: { type: 'plugin.call', contributionId: 'write' } };
            expect(() => parseManifest({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [
                { slot: 'host.rpc', id: 'write', type: 'rpc', method: 'write', entry: 'rpc.mjs', mode: 'write' },
                contribution,
            ] })).toThrow('plugin event RPC must be read mode');
        }
    });
});
