import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MISSING_CWD_ERROR_PREFIX } from '@muxr/contract';
import { createRequestDispatcher } from './createRequestDispatcher.js';
import { createFakeSessionSource, type SessionSource } from '../../agent/index.js';
import { hostPlatformLabel } from '../../machine/index.js';

function dispatcherWithSpy(): { dispatch: ReturnType<typeof createRequestDispatcher>['dispatch']; started: string[] } {
    const started: string[] = [];
    const source = {
        async start({ cwd }: { cwd: string }) {
            started.push(cwd);
            return { info: { id: 'session-1' } };
        },
    } as unknown as SessionSource;
    const { dispatch } = createRequestDispatcher({
        source,
        domain: {} as never,
        machineId: 'm1',
        hostVersion: '0.0.0',
    });
    return { dispatch, started };
}

describe('session.start cwd guard', () => {
    it('refuses a missing cwd without creating it, then creates it once approved', async () => {
        const missing = join(mkdtempSync(join(tmpdir(), 'muxr-cwd-')), 'brand-new-project');
        const { dispatch, started } = dispatcherWithSpy();

        const refused = await dispatch({ type: 'session.start', requestId: 'r1', params: { cwd: missing } } as never);
        expect(refused).toMatchObject({ ok: false });
        expect(String((refused as { error: string }).error)).toContain(MISSING_CWD_ERROR_PREFIX);
        expect(existsSync(missing)).toBe(false);
        expect(started).toEqual([]);

        const created = await dispatch({
            type: 'session.start',
            requestId: 'r2',
            params: { cwd: missing, createCwd: true },
        } as never);
        expect(created).toMatchObject({ ok: true });
        expect(existsSync(missing)).toBe(true);
        expect(started).toEqual([missing]);
    });
});

describe('agent lifecycle request flow', () => {
    it('forwards provider-only starts and routes stale-target failures only by Agent Route', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'muxr-start-'));
        const starts: unknown[] = [];
        const routed: string[] = [];
        const source = {
            async start(options: unknown) {
                starts.push(options);
                return {
                    info: { id: 'stable-session' },
                    acceptance: { outcome: 'accepted', state: 'starting', agentName: 'Herdr Name' },
                };
            },
            async paneFocus(sessionId: string) {
                routed.push(sessionId);
                const error = new Error('That agent is no longer available. Refresh and try again.') as Error & { code: string };
                error.code = 'agent-unavailable';
                throw error;
            },
            async open() { throw new Error('must not fall back'); },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
        });

        const single = await dispatch({
            type: 'session.start', requestId: 'single', params: { cwd, kind: 'codex' },
        } as never);
        const squad = await dispatch({
            type: 'session.start', requestId: 'squad', params: {
                cwd,
                members: [{ kind: 'codex' }, { kind: 'claude' }],
            },
        } as never);
        expect(starts).toEqual([
            { cwd, kind: 'codex' },
            { cwd, members: [{ kind: 'codex' }, { kind: 'claude' }] },
        ]);
        expect(single).toMatchObject({ ok: true, data: { acceptance: { outcome: 'accepted', agentName: 'Herdr Name' } } });
        expect(squad).toMatchObject({ ok: true, data: { acceptance: { outcome: 'accepted', agentName: 'Herdr Name' } } });

        const stale = await dispatch({
            type: 'pane.focus', requestId: 'focus', params: { sessionId: 'stable-session' },
        } as never);
        expect(routed).toEqual(['stable-session']);
        expect(stale).toEqual({
            type: 'result', requestId: 'focus', ok: false, code: 'agent-unavailable',
            error: 'That agent is no longer available. Refresh and try again.',
        });
        expect(JSON.stringify(stale)).not.toMatch(/\/|prompt|pane-|stable-session/);
    });
});

describe('session.stop dispatcher flow', () => {
    it('threads confirmed scope and authenticated replay identity to the close flow', async () => {
        const stops: unknown[] = [];
        const source = {
            async stop(sessionId: string, options: unknown) {
                stops.push({ sessionId, options });
                return { status: 'closed' };
            },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
        });

        const result = await dispatch({
            type: 'session.stop',
            requestId: 'stop-confirmed',
            params: { sessionId: 'route-selected', confirmedScope: 'tab' },
        } as never, 'device-control');
        expect(result).toMatchObject({ ok: true, data: { status: 'closed' } });
        expect(stops).toEqual([{
            sessionId: 'route-selected',
            options: { deviceId: 'device-control', idempotencyKey: 'stop-confirmed', confirmedScope: 'tab' },
        }]);
    });

    it('fake mode closes only the selected session layout and preserves its sibling', async () => {
        const source = createFakeSessionSource();
        await source.start({ cwd: '/tmp/fake-stop' });
        await source.start({ cwd: '/tmp/fake-stop' });
        const before = await source.list();
        const selected = before[0]!;
        const sibling = before[1]!;
        const events: Array<{ sessionId: string; type: string }> = [];
        source.subscribe((sessionId, event) => events.push({ sessionId, type: event.type }));
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
        });

        await expect(dispatch({
            type: 'session.stop', requestId: 'stop-fake', params: { sessionId: selected.id },
        } as never)).resolves.toMatchObject({ ok: true, data: { status: 'closed' } });
        await expect(source.list()).resolves.toEqual([sibling]);
        await expect(source.open({ sessionId: sibling.id })).resolves.toMatchObject({ info: { id: sibling.id } });
        await expect(source.open({ sessionId: selected.id })).rejects.toThrow('unknown session');
        expect(events).toContainEqual({ sessionId: selected.id, type: 'session.removed' });
        await source.dispose();
    });
});

describe('explicit layout close dispatcher flow', () => {
    it('forwards each named target without widening or narrowing its scope', async () => {
        const closes: unknown[] = [];
        const source = {
            async closePane(sessionId: string) { closes.push({ type: 'pane', sessionId }); },
            async closeTab(sessionId: string, tabId: string) { closes.push({ type: 'tab', sessionId, tabId }); },
            async closeWorkspace(workspaceId: string) { closes.push({ type: 'workspace', workspaceId }); },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
        });

        await expect(dispatch({
            type: 'pane.close', requestId: 'close-pane', params: { sessionId: 'route-pane' },
        } as never)).resolves.toMatchObject({ ok: true, data: null });
        await expect(dispatch({
            type: 'tab.close', requestId: 'close-tab', params: { sessionId: 'route-tab', tabId: 'tab-selected' },
        } as never)).resolves.toMatchObject({ ok: true, data: null });
        await expect(dispatch({
            type: 'workspace.close', requestId: 'close-workspace', params: { workspaceId: 'workspace-selected' },
        } as never)).resolves.toMatchObject({ ok: true, data: null });
        expect(closes).toEqual([
            { type: 'pane', sessionId: 'route-pane' },
            { type: 'tab', sessionId: 'route-tab', tabId: 'tab-selected' },
            { type: 'workspace', workspaceId: 'workspace-selected' },
        ]);
    });
});

describe('host capability catalog', () => {
    it('reports launchable agents and the actual host platform', async () => {
        const source = {
            async agentKinds() { return ['pi', 'claude', 'codex']; },
            async installedAgentKinds() { return ['claude']; },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            machineName: 'Build Mac',
            hostVersion: '0.0.0',
        });
        await expect(dispatch({ type: 'herdr.agentKinds', requestId: 'catalog', params: {} } as never, 'device-1'))
            .resolves.toMatchObject({ ok: true, data: { kinds: ['pi', 'claude', 'codex'], installed: ['claude'] } });
        await expect(dispatch({ type: 'machines.list', requestId: 'machines', params: {} } as never, 'device-1'))
            .resolves.toMatchObject({
                ok: true,
                data: [{ name: 'Build Mac', platform: hostPlatformLabel() }],
            });
    });
});

describe('plugin device authority', () => {
    it('binds approvals and calls to the authenticated sender and blocks browser mutation', async () => {
        const calls: unknown[] = [];
        const source = {
            async open(options: unknown) { calls.push(options); return { info: { id: 'session-1' } }; },
            async pluginApprove(options: unknown) { calls.push(options); },
            async pluginCall(options: unknown) { calls.push(options); return { ok: true }; },
            pluginRpcMode(options: { contributionId: string }) { return options.contributionId === 'rpc' ? 'read' as const : 'write' as const; },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            canMutateDevice: (deviceId) => deviceId !== 'browser-1',
        });
        const request = { type: 'plugin.approve', requestId: 'approve', params: { pluginId: 'example.ui', manifestHash: 'hash', approved: true } } as never;
        expect(await dispatch(request, 'native-1')).toMatchObject({ ok: true });
        expect(calls).toEqual([{ pluginId: 'example.ui', manifestHash: 'hash', approved: true, deviceId: 'native-1' }]);
        expect(await dispatch(request, 'browser-1')).toMatchObject({ ok: false, error: expect.stringContaining('view-only') });
        expect(calls).toHaveLength(1);
        const call = { type: 'plugin.call', requestId: 'call', params: { pluginId: 'example.ui', manifestHash: 'hash', contributionId: 'rpc', input: { value: 1 } } } as never;
        expect(await dispatch(call, 'native-1')).toMatchObject({ ok: true, data: { ok: true } });
        expect(calls[1]).toMatchObject({ deviceId: 'native-1', contributionId: 'rpc' });
        expect(await dispatch(call, 'browser-1')).toMatchObject({ ok: true, data: { ok: true } });
        const writeCall = { type: 'plugin.call', requestId: 'call-2', params: { pluginId: 'example.ui', manifestHash: 'hash', contributionId: 'write-rpc' } } as never;
        expect(await dispatch(writeCall, 'browser-1')).toMatchObject({ ok: false, error: expect.stringContaining('view-only') });

        const open = { type: 'session.open', requestId: 'open', params: { sessionId: 'session-1' } } as never;
        expect(await dispatch(open, 'browser-1')).toMatchObject({ ok: true });
        expect(calls[3]).toEqual({ sessionId: 'session-1', acknowledgeAttention: false });
        expect(await dispatch(open, 'native-1')).toMatchObject({ ok: true });
        expect(calls[4]).toEqual({ sessionId: 'session-1' });
    });
});

describe('voice provider selection', () => {
    it('lists every provider but only lets a native device switch the active one', async () => {
        let selected = 'xai';
        const providers = () => ['xai', 'gemini', 'openai'].map((id) => ({
            id,
            name: id,
            selected: id === selected,
            source: { kind: 'local' as const },
            hasBackend: true,
        }));
        const source = {
            async voiceProviderList() { return providers(); },
            async voiceProviderSelect(provider: string) { selected = provider; return providers(); },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            canMutateDevice: (deviceId) => deviceId !== 'browser-1',
        });

        expect(await dispatch({ type: 'voice.provider.list', requestId: 'list', params: {} } as never, 'browser-1'))
            .toMatchObject({ ok: true, data: [{ id: 'xai', selected: true }, { id: 'gemini' }, { id: 'openai' }] });
        expect(await dispatch({ type: 'voice.provider.select', requestId: 'select', params: { providerId: 'gemini' } } as never, 'browser-1'))
            .toMatchObject({ ok: false, error: expect.stringContaining('view-only') });
        expect(await dispatch({ type: 'voice.provider.select', requestId: 'select', params: { providerId: 'gemini' } } as never, 'native-1'))
            .toMatchObject({ ok: true, data: expect.arrayContaining([expect.objectContaining({ id: 'gemini', selected: true, name: 'gemini' })]) });
    });
});

describe('unknown request type guard', () => {
    it('answers a stable host-contract-mismatch result instead of throwing', async () => {
        const { dispatch } = dispatcherWithSpy();
        const unknown = await dispatch({ type: 'bogus.request', requestId: 'r-unknown', params: {} } as never);
        expect(unknown).toMatchObject({
            type: 'result',
            requestId: 'r-unknown',
            ok: false,
            code: 'host-contract-mismatch',
        });
        const error = (unknown as { error: string }).error;
        expect(error).toContain('host/APK contract mismatch');
        expect(error).toContain('bogus.request');
    });
});
