import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginEventTrigger, PluginManifestV1, PluginScreenButtonNode, PluginScreenContribution } from '@muxr/contract';
import { defaultPluginText, parseManifest, parseManifestWithMeta, parsePluginAction, resolvePluginText } from '@muxr/contract';
import { firedTriggers } from './pluginEvents';
import { asPluginCollection } from './collectionModel';
import { asPluginTree } from './treeModel';
import { asScreenTabs, bindText, bindTone, buttonInput, contentMountTitle, initialFieldValues, loadScreenData, runScreenButton, shouldReloadAfterAction, WriteKeyStore } from './screenModel';
import { asScreenTree } from './screenTreeModel';
import { asChartSeries } from './chartModel';
import { asLimitsPayload } from './limitsModel';
import { asRightNowPayload, vitalsFacts } from '@/herd';
import { highlightCodeLines, syntaxLanguage } from '@/components/code/syntaxHighlighting';

const manifest: PluginManifestV1 = {
    schemaVersion: 1,
    pluginId: 'example.muxr-ui',
    contributions: [
        { slot: 'host.rpc', id: 'list-rpc', type: 'rpc', method: 'list', entry: 'rpc.mjs', mode: 'read' },
        { slot: 'host.rpc', id: 'save-rpc', type: 'rpc', method: 'save', entry: 'rpc.mjs', mode: 'write' },
        {
            slot: 'navigation.content', id: 'main', type: 'screen', title: '{{data.title}}',
            data: { type: 'plugin.call', contributionId: 'list-rpc' },
            children: [
                { type: 'section', title: 'Details', children: [
                    { type: 'metric', label: 'Status', value: '{{data.status}}' },
                    { type: 'badge', label: '{{data.tier}}', tone: 'positive' },
                    { type: 'field', kind: 'text', id: 'name', label: 'Name', value: 'Ada' },
                ] },
                { type: 'list', title: 'Recent', emptyText: 'Empty', rows: [{ type: 'row', title: '{{data.first}}' }, { type: 'row', title: '{{data.second}}' }] },
                { type: 'field', kind: 'switch', id: 'enabled', label: 'Enabled', value: 'true' },
                { type: 'field', kind: 'select', id: 'tier', label: 'Tier', options: ['free', 'pro'], value: 'free' },
                { type: 'button', label: 'Save', action: { type: 'plugin.call', contributionId: 'save-rpc' }, fields: ['name', 'enabled', 'tier'], variant: 'primary' },
                { type: 'button', label: 'Refresh', action: { type: 'plugin.call', contributionId: 'list-rpc' } },
            ],
        },
    ],
};

const screen = manifest.contributions.find((contribution): contribution is PluginScreenContribution =>
    'type' in contribution && contribution.type === 'screen')!;

describe('declarative screen flow', () => {
    it('loads data, renders list/detail bindings, and submits the form through plugin.call with write idempotency', async () => {
        const calls: { params: Record<string, unknown> }[] = [];
        const request = vi.fn(async (type: 'plugin.call', params: { pluginId: string; manifestHash: string; contributionId: string; input?: unknown; idempotencyKey?: string }) => {
            calls.push({ params });
            if (params.contributionId === 'list-rpc') {
                return { title: 'Example', status: 'ok', tier: 'beta', first: 'Row A', second: 'Row B' };
            }
            return { saved: params.input };
        });

        // Screen data loads through a declared read RPC; bindings resolve.
        const data = await loadScreenData(screen.data!.contributionId, manifest, 'example.muxr-ui', 'hash', request);
        expect(calls).toEqual([{ params: { pluginId: 'example.muxr-ui', manifestHash: 'hash', contributionId: 'list-rpc' } }]);
        expect(bindText(defaultPluginText(screen.title!), data)).toBe('Example');
        const details = screen.children[0];
        if (details.type !== 'section') throw new Error('section missing');
        if (details.children[0].type !== 'metric') throw new Error('metric missing');
        expect(bindText(defaultPluginText(details.children[0].value), data)).toBe('ok');

        // Form state is collected from declared fields (including nested ones)
        // and submitted as the write RPC input with a client idempotency key.
        const fields = initialFieldValues(screen);
        expect(fields).toEqual({ name: 'Ada', enabled: true, tier: 'free' });
        fields.name = 'Grace';
        fields.enabled = false;
        fields.tier = 'pro';

        const button = screen.children.find((node): node is PluginScreenButtonNode => node.type === 'button' && node.action.type === 'plugin.call' && node.action.contributionId === 'save-rpc')!;
        expect(buttonInput(button, fields)).toEqual({ name: 'Grace', enabled: false, tier: 'pro' });

        // One idempotency key per write while the input is unchanged: success
        // clears it, so a subsequent press mints a fresh key.
        let key = 0;
        const writeKeys = new WriteKeyStore();
        const slot = 'example.muxr-ui:hash:save-rpc';
        const run = () => runScreenButton(
            { button, fields, pluginId: 'example.muxr-ui', manifestHash: 'hash', manifest, writeKeys, slot, newIdempotencyKey: () => `key-${++key}` },
            request,
        );
        const first = await run();
        expect(first).toEqual({ ok: true, text: '{"saved":{"name":"Grace","enabled":false,"tier":"pro"}}' });
        expect(calls[1].params).toMatchObject({ contributionId: 'save-rpc', idempotencyKey: 'key-1', input: { name: 'Grace', enabled: false, tier: 'pro' } });

        // A fresh press after success mints a new key (the old one was cleared).
        const second = await run();
        expect(second.ok).toBe(true);
        expect(calls[2].params).toMatchObject({ contributionId: 'save-rpc', idempotencyKey: 'key-2' });

        // An input change mints a fresh key (never reusing the old one).
        fields.name = 'Lin';
        await run();
        expect(calls[3].params).toMatchObject({ contributionId: 'save-rpc', idempotencyKey: 'key-3' });

        // Read-only buttons never send an idempotency key.
        const refresh = screen.children.find((node): node is PluginScreenButtonNode => node.type === 'button' && node.action.type === 'plugin.call' && node.action.contributionId === 'list-rpc')!;
        await runScreenButton({ button: refresh, fields, pluginId: 'example.muxr-ui', manifestHash: 'hash', manifest, writeKeys, slot: 'read', newIdempotencyKey: () => `key-${++key}` }, request);
        expect(calls[4].params).toEqual({ pluginId: 'example.muxr-ui', manifestHash: 'hash', contributionId: 'list-rpc' });

        // A failed write keeps its key for a retry with unchanged input.
        const failOnce = vi.fn(async (type: 'plugin.call', params: { contributionId: string }) => {
            if (params.contributionId === 'save-rpc') throw new Error('network dropped');
            return {};
        });
        const failing = await runScreenButton(
            { button, fields, pluginId: 'example.muxr-ui', manifestHash: 'hash', manifest, writeKeys, slot, newIdempotencyKey: () => `key-${++key}` },
            failOnce,
        );
        expect(failing.ok).toBe(false);
        const afterFail = await runScreenButton(
            { button, fields, pluginId: 'example.muxr-ui', manifestHash: 'hash', manifest, writeKeys, slot, newIdempotencyKey: () => `key-${++key}` },
            request,
        );
        expect(afterFail.ok).toBe(true);
        // The retry reuses the key held through the ambiguous failure.
        expect(failOnce.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'key-4' });
        expect(request.mock.calls[request.mock.calls.length - 1][1]).toMatchObject({ idempotencyKey: 'key-4' });

        // The component reloads screen data only after successful writes; reads
        // and failed writes never create a refresh loop.
        expect(shouldReloadAfterAction(manifest, button.action, afterFail.ok)).toBe(true);
        expect(shouldReloadAfterAction(manifest, refresh.action, true)).toBe(false);
        expect(shouldReloadAfterAction(manifest, button.action, false)).toBe(false);

        // Canonical hashing reuses a retry key independent of object key order,
        // while changed secret input mints a new key without retaining plaintext.
        const actionKeys = new WriteKeyStore();
        let actionKey = 0;
        expect(actionKeys.keyFor('write', { secret: 'one', nested: { b: 2, a: 1 } }, () => `action-${++actionKey}`)).toBe('action-1');
        expect(actionKeys.keyFor('write', { nested: { a: 1, b: 2 }, secret: 'one' }, () => `action-${++actionKey}`)).toBe('action-1');
        expect(actionKeys.keyFor('write', { secret: 'two', nested: { a: 1, b: 2 } }, () => `action-${++actionKey}`)).toBe('action-2');
    });

    it('caps bound text defensively by UTF-8 bytes', () => {
        const long = '😀'.repeat(3000); // 4 bytes per code point
        const bound = bindText('{{data.v}}', { v: long });
        expect(new TextEncoder().encode(bound).length).toBe(4096); // byte cap, not char cap
        expect(bindText('plain template', { v: long })).toBe('plain template');
        // Static templates (no bindings) are sanitized and capped too.
        expect(bindText('a\u202Eb\u200Bc', {})).toBe('abc');
        expect(new TextEncoder().encode(bindText(long, {})).length).toBe(4096);
    });

    it('validates a generic folder tree and binds its selected working directory', () => {
        const parsed = parseManifest({
            schemaVersion: 1,
            pluginId: 'example.tree',
            minMuxrVersion: 11,
            contributions: [{
                slot: 'navigation.content', id: 'browse', type: 'screen', children: [
                    { type: 'field', kind: 'text', id: 'cwd', label: 'Folder', value: '{{data.cwd}}' },
                    { type: 'tree', path: 'data.folders', selectionField: 'cwd' },
                    { type: 'code', path: 'data.body', fileNamePath: 'data.name' },
                ],
            }],
        });
        const treeScreen = parsed.contributions[0];
        if (!('type' in treeScreen) || treeScreen.type !== 'screen') throw new Error('screen missing');
        expect(treeScreen.children[1]).toMatchObject({ type: 'tree', path: 'data.folders', selectionField: 'cwd' });
        expect(treeScreen.children[2]).toEqual({ type: 'code', path: 'data.body', fileNamePath: 'data.name' });
        const review = parseManifest({
            schemaVersion: 1,
            pluginId: 'you.review',
            minMuxrVersion: 11,
            contributions: [{
                slot: 'navigation.content', id: 'review', type: 'screen',
                children: [
                    { type: 'code', path: 'data.body', fileNamePath: 'data.name' },
                    { type: 'diff', path: 'data.patch' },
                ],
            }],
        }).contributions[0];
        if (!('type' in review) || review.type !== 'screen') throw new Error('review screen missing');
        expect(review.children).toEqual([
            { type: 'code', path: 'data.body', fileNamePath: 'data.name' },
            { type: 'diff', path: 'data.patch' },
        ]);
        // A file screen can ask to own the scroll; anything else is not a
        // viewport this app knows how to lay out.
        const file = parseManifest({
            schemaVersion: 1,
            pluginId: 'you.file',
            minMuxrVersion: 11,
            contributions: [{
                slot: 'navigation.content', id: 'file', type: 'screen',
                children: [{ type: 'code', path: 'data.body', fileNamePath: 'data.path', viewport: 'fill' }],
            }],
        }).contributions[0];
        if (!('type' in file) || file.type !== 'screen') throw new Error('file screen missing');
        expect(file.children[0]).toEqual({ type: 'code', path: 'data.body', fileNamePath: 'data.path', viewport: 'fill' });
        expect(() => parseManifest({
            schemaVersion: 1,
            pluginId: 'you.file',
            minMuxrVersion: 11,
            contributions: [{
                slot: 'navigation.content', id: 'file', type: 'screen',
                children: [{ type: 'code', path: 'data.body', viewport: 'tall' }],
            }],
        })).toThrow();
        expect(syntaxLanguage(undefined, 'src/index.tsx')).toBe('tsx');
        expect(syntaxLanguage('unknown', 'src/index.tsx')).toBe('tsx');
        expect(highlightCodeLines('const answer = 42;', 'typescript').flat()).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'const', type: 'keyword' }), expect.objectContaining({ text: '42', type: 'number' })]));
        expect(highlightCodeLines(`const value = "${'x'.repeat(4000)}";`, 'typescript').flat()).toEqual([{ text: `const value = "${'x'.repeat(4000)}";` }]);
        expect(initialFieldValues(treeScreen, { cwd: '/repo/apps/mobile' })).toEqual({ cwd: '/repo/apps/mobile' });
        expect(asScreenTree([
            null,
            { name: 'repo', path: '/repo', kind: 'folder' },
            { name: 'apps', path: '/repo/apps', parent: '/repo', kind: 'folder' },
            { name: 'index.ts', path: '/repo/apps/index.ts', parent: '/repo/apps', kind: 'file' },
        ])).toMatchObject([{ name: 'repo', children: [{ name: 'apps', children: [{ name: 'index.ts' }] }] }]);
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'bad.tree', contributions: [{
                slot: 'navigation.content', id: 'bad', type: 'screen',
                children: [{ type: 'tree', path: 'data.folders', selectionField: 'missing' }],
            }],
        })).toThrow('unknown field');
    });

    it('validates v13 dynamic visuals: bound progress, columns, and bounded charts', () => {
        const parsed = parseManifest({
            schemaVersion: 1, pluginId: 'example.charts', minMuxrVersion: 13,
            contributions: [{
                slot: 'navigation.content', id: 'charts', type: 'screen',
                children: [
                    { type: 'section', columns: 2, children: [
                        { type: 'metric', label: 'A', value: '1' },
                        { type: 'metric', label: 'B', value: '2' },
                    ] },
                    { type: 'progress', path: 'data.progress', label: 'Left', valueLabel: '{{data.left}}' },
                    { type: 'chart', variant: 'bar', path: 'data.bars' },
                    { type: 'chart', variant: 'ring', path: 'data.rings' },
                ],
            }],
        });
        expect(parsed.contributions[0]).toMatchObject({ type: 'screen' });

        // Version gate: v13 shapes must not silently degrade on older phones.
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'example.charts',
            contributions: [{
                slot: 'navigation.content', id: 'c', type: 'screen',
                children: [{ type: 'chart', variant: 'bar', path: 'data.bars' }],
            }],
        })).toThrow('minMuxrVersion 13');

        // Exactly one of path/value; columns only for summary children.
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'example.charts', minMuxrVersion: 13,
            contributions: [{
                slot: 'navigation.content', id: 'c', type: 'screen',
                children: [{ type: 'progress', path: 'data.p', value: 3 }],
            }],
        })).toThrow('exactly one');
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'example.charts', minMuxrVersion: 13,
            contributions: [{
                slot: 'navigation.content', id: 'c', type: 'screen',
                children: [{ type: 'section', columns: 2, children: [{ type: 'field', kind: 'text', id: 'x', label: 'X' }] }],
            }],
        })).toThrow('summary nodes');

        // Runtime chart data is untrusted: bound it before it reaches the SVG.
        expect(asChartSeries([
            { label: 'Claude', value: 10, tone: 'positive' },
            { label: 'long'.repeat(20), value: 5 },
            { label: 'bad', value: Number.NaN },
            { label: 'neg', value: -1 },
            { label: 'raw', value: 2, tone: '#ff0000' },
            { label: 42, value: 3 },
            ...Array.from({ length: 10 }, (_, i) => ({ label: `x${i}`, value: 1 })),
        ])).toHaveLength(8);
        expect(asChartSeries([{ label: 'zero', value: 0 }])).toEqual([]);
        expect(asChartSeries('nope')).toEqual([]);
    });

    it('keeps a null RPC result successful', async () => {
        const save = screen.children.find((node): node is PluginScreenButtonNode => node.type === 'button' && node.action.type === 'plugin.call' && node.action.contributionId === 'save-rpc')!;
        const request = vi.fn(async () => null);
        const outcome = await runScreenButton(
            { button: save, fields: {}, pluginId: 'example.muxr-ui', manifestHash: 'hash', manifest, writeKeys: new WriteKeyStore(), slot: 'save', newIdempotencyKey: () => 'key-null' },
            request,
        );
        expect(outcome).toEqual({ ok: true, text: 'null' });
    });
});

describe('button input', () => {
    it('carries the record the screen was opened with', () => {
        const button = { type: 'button', label: 'Stop', action: { type: 'plugin.call', contributionId: 'stop' } } as PluginScreenButtonNode;
        // a detail screen acts on what you tapped, without retyping it
        expect(buttonInput(button, {}, { pid: '123' })).toEqual({ pid: '123' });
        // what you typed wins over what you navigated from
        expect(buttonInput({ ...button, fields: ['pid'] }, { pid: '999' }, { pid: '123' })).toEqual({ pid: '999' });
        expect(buttonInput(button, {}, undefined)).toBeUndefined();
    });
});

describe('source-driven native models', () => {
    it('bounds and sanitizes grouped collection groups, items, timestamps, and actions', () => {
        const model = asPluginCollection({
            title: 'Feed',
            groups: [
                { id: 'one', title: 'Workspace', items: [
                    { id: 'a', title: 'Needs review', subtitle: 'answer', glyph: 'pi', status: 'danger', pulsing: true, timestamp: '2026-08-15T12:00:00.000Z', action: { type: 'kernel.navigate', target: 'session', sessionId: 'pp_1234abcd' } },
                    { id: 'bad', title: 'Unsafe', action: { type: 'shell.run', command: 'rm -rf /' } },
                ] },
                ...Array.from({ length: 30 }, (_, index) => ({ id: `g${index}`, title: `Group ${index}`, items: [] })),
            ],
        }, parsePluginAction);
        expect(model.groups).toHaveLength(1); // empty groups are omitted
        expect(model.groups[0]?.items).toHaveLength(1);
        expect(model.groups[0]?.items[0]).toMatchObject({
            title: 'Needs review', status: 'danger', pulsing: true,
            action: { type: 'kernel.navigate', target: 'session', sessionId: 'pp_1234abcd' },
        });
    });

    it('bounds recursive tree nodes and validates every node action', () => {
        const model = asPluginTree({
            title: 'Workspace',
            nodes: [{
                id: 'tab', title: 'review', status: 'warning', pulsing: true,
                children: [{
                    id: 'session', title: 'pi', current: true,
                    action: { type: 'kernel.navigate', target: 'session', sessionId: 'pp_1234abcd' },
                    actions: [{ id: 'open', label: 'Open', action: { type: 'kernel.navigate', target: 'session', sessionId: 'pp_1234abcd' } }],
                }],
            }, { id: 'bad', title: 'bad', action: { type: 'kernel.navigate', target: 'unknown' } }],
        }, parsePluginAction);
        expect(model.nodes).toHaveLength(1);
        expect(model.nodes[0]?.children?.[0]).toMatchObject({
            title: 'pi', current: true,
            action: { type: 'kernel.navigate', target: 'session', sessionId: 'pp_1234abcd' },
        });
        expect(model.nodes[0]?.children?.[0]?.actions).toHaveLength(1);
    });
});

describe('plugin event triggers', () => {
    const parse = (event: unknown) => parseManifest({
        schemaVersion: 1, pluginId: 'example.muxr-ui',
        contributions: [
            { slot: 'host.rpc', id: 'on-stop', type: 'rpc', method: 'on-stop', entry: 'rpc.mjs', mode: 'read' },
            event,
        ],
    }).contributions.find((c) => c.slot === 'events') as PluginEventTrigger;

    const event = {
        slot: 'events', id: 'react', on: 'agent.status', from: 'working', to: ['idle', 'blocked'],
        action: { type: 'plugin.call', contributionId: 'on-stop', include: 'pane' },
    };

    it('reacts by calling the plugin\'s own backend', () => {
        const parsed = parse(event);
        expect(parsed.action).toEqual({ type: 'plugin.call', contributionId: 'on-stop', include: 'pane' });
        expect(parsed.to).toEqual(['idle', 'blocked']);
    });

    it('fires only on the declared transition, never on a resting status', () => {
        const declared = [parse(event)];
        expect(firedTriggers(declared, 'working', 'idle')).toHaveLength(1);
        expect(firedTriggers(declared, 'working', 'blocked')).toHaveLength(1);
        // 'idle' sits there forever; acting on the value would repeat every tick.
        expect(firedTriggers(declared, 'idle', 'idle')).toEqual([]);
        expect(firedTriggers(declared, 'working', 'done')).toEqual([]);
        expect(firedTriggers(declared, 'idle', 'working')).toEqual([]);
    });

    it('carries a phone-side capability by name without interpreting it', () => {
        const parsed = parse({ ...event, action: { type: 'capability', name: 'speech.wake', include: 'pane' } });
        expect(parsed.action).toEqual({ type: 'capability', name: 'speech.wake', include: 'pane' });
    });

    it('keeps feature names out of the kernel and requires a declared RPC', () => {
        // A kernel that knows what "voice" is cannot be replaced by another plugin.
        expect(() => parse({ ...event, action: { type: 'voice.wake', prompt: { idle: 'a' } } })).toThrow();
        expect(() => parse({ ...event, action: { type: 'shell.run', command: 'rm -rf /' } })).toThrow();
        expect(() => parse({ ...event, action: { type: 'plugin.call', contributionId: 'missing' } })).toThrow();
        expect(() => parse({ ...event, on: 'file.changed' })).toThrow();
        expect(() => parse({ ...event, from: 'nonsense' })).toThrow();
    });
});

describe('plugin shortcuts', () => {
    it('reuses the event action union and rejects an empty synonym list', () => {
        const parsed = parseManifest({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [{
                slot: 'shortcuts', id: 'jarvis', label: 'Jarvis',
                synonyms: ['Jarvis', 'talk'],
                action: { type: 'capability', name: 'voice.start' },
            }],
        }).contributions[0];
        expect(parsed).toMatchObject({ slot: 'shortcuts', id: 'jarvis', action: { type: 'capability', name: 'voice.start' } });
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [{
                slot: 'shortcuts', id: 'jarvis', label: 'Jarvis',
                synonyms: [],
                action: { type: 'capability', name: 'voice.start' },
            }],
        })).toThrow('invalid plugin shortcut synonyms');
    });

    it('parses bounded localized text and resolves exact, base, then default locales', () => {
        const parsed = parseManifest({
            schemaVersion: 1, pluginId: 'example.muxr-ui', minMuxrVersion: 6,
            contributions: [{
                slot: 'shortcuts', id: 'open',
                label: { default: 'Open', translations: { es: 'Abrir', 'zh-Hant': '開啟' } },
                synonyms: [{ default: 'launch', translations: { es: 'iniciar' } }],
                action: { type: 'capability', name: 'example.open' },
            }],
        }).contributions[0];
        if (parsed?.slot !== 'shortcuts') throw new Error('shortcut missing');
        expect(resolvePluginText(parsed.label, 'zh-Hant')).toBe('開啟');
        expect(resolvePluginText(parsed.label, 'es-MX')).toBe('Abrir');
        expect(resolvePluginText(parsed.label, 'de')).toBe('Open');
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [{ slot: 'shortcuts', id: 'old', label: { default: 'Old', translations: { es: 'Viejo' } }, synonyms: ['old'], action: { type: 'capability', name: 'example.open' } }],
        })).toThrow('localized plugin text requires minMuxrVersion 6');
        const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-${String(index).padStart(2, '0')}`, 'value']));
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [{ slot: 'shortcuts', id: 'bad', label: { default: 'Bad', translations: tooMany }, synonyms: ['bad'], action: { type: 'capability', name: 'example.open' } }],
        })).toThrow('invalid localized plugin translation count');
        expect(() => parseManifest({
            schemaVersion: 1, pluginId: 'example.muxr-ui',
            contributions: [{ slot: 'shortcuts', id: 'bad', label: { default: 'Bad', translations: { 'not_a_locale': 'bad' } }, synonyms: ['bad'], action: { type: 'capability', name: 'example.open' } }],
        })).toThrow('invalid localized plugin locale');
    });
});

describe('usage tab marks and bounded limits payload', () => {
    it('keeps well-formed tab glyphs and drops anything else', () => {
        const tabs = asScreenTabs([
            { id: 'zai', label: 'Z.ai', glyph: 'zai' },
            { id: 'claude', label: 'Claude', glyph: 'claude' },
            { id: 'bad', label: 'Bad', glyph: '../etc' },
            { id: 'none', label: 'No mark' },
            { id: 'x', label: 'X', glyph: 9 },
        ]);
        expect(tabs).toEqual([
            { id: 'zai', label: 'Z.ai', glyph: 'zai' },
            { id: 'claude', label: 'Claude', glyph: 'claude' },
            { id: 'bad', label: 'Bad' },
            { id: 'none', label: 'No mark' },
            { id: 'x', label: 'X' },
        ]);
    });

    it('bounds an untrusted limits payload at the untrusted-input boundary', () => {
        const payload = asLimitsPayload({
            plan: 'x'.repeat(60),
            verdict: 'catastrophic',
            windows: [
                { label: 'ok', used: 44, window: '5h', resetsIn: '3h 1m', elapsed: 0.4 },
                { label: 'over', used: 240 },
                { label: 'nan', used: Number.NaN },
                { label: 'bad-elapsed', used: 10, elapsed: 7 },
                { label: 'y'.repeat(60), used: 10 },
                { label: 'reset-toolong', used: 10, resetsIn: 'z'.repeat(40) },
                'not-an-object',
            ],
            extra: 'ignored',
        });
        expect(payload.verdict).toBe('unknown');
        expect(payload.plan).toHaveLength(40);
        expect(payload.windows).toEqual([
            { label: 'ok', used: 44, window: '5h', resetsIn: '3h 1m', elapsed: 0.4 },
            // Out-of-range shares drop the window; an impossible elapsed only
            // loses the tick, and oversize strings cap instead of dropping.
            { label: 'bad-elapsed', used: 10 },
            { label: 'y'.repeat(24), used: 10 },
            { label: 'reset-toolong', used: 10, resetsIn: 'z'.repeat(24) },
        ]);
        // Not an object at all: an unknown, windowless payload, never a throw.
        expect(asLimitsPayload('nope')).toEqual({ verdict: 'unknown', windows: [] });
    });

    it('bounds untrusted machine vitals and loses only the figure the host could not read', () => {
        const vitals = asRightNowPayload({
            vitals: {
                memoryUsed: 56_375_000_000, memoryTotal: 98_784_000_000,
                diskUsed: 431_600_000_000, diskTotal: 998_000_000_000,
                load1: 5.27, uptimeSeconds: 425_000,
            },
        }).vitals;
        expect(vitalsFacts(vitals!)).toEqual({ memoryPercent: 57, diskPercent: 43, load: '5.3', uptime: '4d' });
        // A filesystem the host could not stat drops its own figure; memory,
        // load and uptime still answer.
        const statless = asRightNowPayload({ vitals: { memoryUsed: 1, memoryTotal: 4, load1: 2, uptimeSeconds: 7_200 } }).vitals;
        expect(vitalsFacts(statless!)).toEqual({ memoryPercent: 25, load: '2', uptime: '2h' });
        // A zero ceiling would divide the share by zero, so the whole object goes.
        expect(asRightNowPayload({ vitals: { memoryUsed: 1, memoryTotal: 0, load1: 1, uptimeSeconds: 1 } }).vitals).toBeUndefined();
    });
});

describe('declarative screen identity platform', () => {
    it('bounds bound tones, bound field values and the title rule at the untrusted-input boundary', () => {
        const data = { tone: 'danger', evil: 'red', on: 'true', reporter: 'tap', blank: '' };
        // A bound tone resolves a tone name; anything else is no tone, never a throw.
        expect(bindTone({ tonePath: 'data.tone' }, data)).toBe('danger');
        expect(bindTone({ tonePath: 'data.evil' }, data)).toBeUndefined();
        expect(bindTone({ tonePath: 'data.missing' }, data)).toBeUndefined();
        expect(bindTone({ tone: 'warning' }, data)).toBe('warning');
        expect(bindTone({}, data)).toBeUndefined();
        // A blank notice binds to nothing, which is what hides it.
        expect(bindText('{{data.blank}}', data)).toBe('');
        // A switch seeded from saved state reads 'true' as on; a select keeps
        // saved state when it names an option and falls back to the first one.
        const parsed = parseManifest({
            schemaVersion: 1, pluginId: 'you.testrun', minMuxrVersion: 14,
            contributions: [{
                slot: 'navigation.content', id: 'settings', type: 'screen',
                children: [
                    { type: 'field', kind: 'switch', id: 'runsave', label: 'Run', valuePath: 'data.on' },
                    { type: 'field', kind: 'switch', id: 'off', label: 'Off', valuePath: 'data.missing' },
                    { type: 'field', kind: 'select', id: 'reporter', label: 'Reporter', options: ['spec', 'tap'], valuePath: 'data.reporter' },
                    { type: 'field', kind: 'select', id: 'unknown', label: 'Unknown', options: ['spec', 'tap'], valuePath: 'data.evil' },
                ],
            }],
        });
        const settings = parsed.contributions[0];
        if (!('type' in settings) || settings.type !== 'screen') throw new Error('screen missing');
        expect(initialFieldValues(settings, data)).toEqual({ runsave: true, off: false, reporter: 'tap', unknown: 'spec' });
        // A limits payload with one malformed window keeps the good one.
        expect(asLimitsPayload({ verdict: 'go', windows: [{ label: 'ok', used: 10 }, { label: 'bad', used: 'x' }] }).windows)
            .toEqual([{ label: 'ok', used: 10 }]);
        // The header already says "Usage", so an in-body "Usage" is a duplicate.
        const usage = parseManifest({
            schemaVersion: 1, pluginId: 'muxr.status',
            contributions: [
                { slot: 'navigation.primary', id: 'usage.nav', type: 'navigation-item', label: 'Usage', icon: 'speedometer-outline', contentContributionId: 'usage.details' },
                { slot: 'navigation.content', id: 'usage.details', type: 'screen', title: 'Usage', children: [] },
            ],
        });
        const resolve = (value: string | { default: string }): string => typeof value === 'string' ? value : value.default;
        expect(contentMountTitle(usage, 'usage.details', 'Status', resolve)).toBe('Usage');
        expect(contentMountTitle(usage, 'usage.unknown', 'Status', resolve)).toBe('Status');
    });

    it('carries every shipped manifest through the new parser with nothing dropped, and ignores unknown fields', () => {
        const dir = fileURLToPath(new URL('../../../../../plugins', import.meta.url));
        // Every user-visible string on a shipped screen must flow through the
        // new binder without throwing; paths and ids are data, not templates.
        const TEMPLATE_KEYS = new Set(['text', 'title', 'subtitle', 'meta', 'value', 'label', 'message', 'emptyText', 'valueLabel', 'placeholder']);
        const bound: string[] = [];
        const walk = (value: unknown): void => {
            if (typeof value === 'string') return;
            if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
            if (typeof value !== 'object' || value === null) return;
            for (const [key, entry] of Object.entries(value)) {
                if (TEMPLATE_KEYS.has(key) && (typeof entry === 'string' || (typeof entry === 'object' && entry !== null && 'default' in entry))) {
                    const template = typeof entry === 'string' ? entry : (entry as { default: string }).default;
                    bound.push(bindText(template, {}));
                } else walk(entry);
            }
        };
        let screens = 0;
        for (const name of ['status', 'voice']) {
            const raw = JSON.parse(readFileSync(join(dir, name, 'muxr-ui.json'), 'utf8'));
            const { manifest, skippedScreenNodes } = parseManifestWithMeta(raw);
            expect(skippedScreenNodes).toEqual([]);
            for (const contribution of manifest.contributions) {
                if (!('type' in contribution) || contribution.type !== 'screen') continue;
                screens += 1;
                walk(contribution);
                expect(initialFieldValues(contribution, {})).toBeTypeOf('object');
            }
        }
        // Five screens ship today; every one must survive the new parser.
        expect(screens).toBe(5);
        expect(bound.length).toBeGreaterThan(0);
        // An app that does not know a new field ignores it rather than breaking.
        const unknown = parseManifest({
            schemaVersion: 1, pluginId: 'you.future',
            contributions: [{
                slot: 'navigation.content', id: 's', type: 'screen',
                children: [
                    { type: 'row', title: 'R', frobnicate: ['tomorrow'] },
                    { type: 'text', text: 'T', whatever: { nested: true } },
                ],
            }],
        });
        const future = unknown.contributions[0];
        if (!('type' in future) || future.type !== 'screen') throw new Error('screen missing');
        expect(future.children).toEqual([
            { type: 'row', title: 'R' },
            { type: 'text', text: 'T' },
        ]);
    });
});
