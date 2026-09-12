import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MISSING_CWD_ERROR_PREFIX } from '@muxr/contract';
import { createRequestDispatcher } from './createRequestDispatcher.js';
import { createAgentWatchStores, createFakeSessionSource, markPromptDispatched, type SessionSource } from '../../agent/index.js';
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

    it('rejects a start that never published an agent so the journal can keep start-launch-failed', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'muxr-start-fail-'));
        const source = {
            async start() {
                return {
                    acceptance: {
                        outcome: 'failed',
                        state: 'failed',
                        code: 'start-launch-failed',
                        message: 'Agent could not start.',
                    },
                };
            },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
        });
        const failed = await dispatch({
            type: 'session.start', requestId: 'fail', params: { cwd, kind: 'pi' },
        } as never);
        expect(failed).toEqual({
            type: 'result',
            requestId: 'fail',
            ok: false,
            error: 'Agent could not start.',
            code: 'start-launch-failed',
        });
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

describe('prompt resend after a lost answer', () => {
    // One validity per submission, like the client keeps on a resend.
    const validity = new Map<string, number>();
    const later = (promptId?: unknown) => {
        const key = String(promptId);
        const known = validity.get(key) ?? Date.now() + 60_000;
        validity.set(key, known);
        return known;
    };
    const build = (dataDir: string, source: SessionSource) => createRequestDispatcher({
        source,
        domain: createAgentWatchStores({ dataDir }),
        machineId: 'm1',
        hostVersion: '0.0.0',
    }).dispatch;
    const promptOf = (dispatch: ReturnType<typeof createRequestDispatcher>['dispatch'], device = 'browser-1') =>
        (requestId: string, text: string, promptId: unknown, extra: Record<string, unknown> = {}) =>
            dispatch({ type: 'session.prompt', requestId, params: { sessionId: 's1', text, promptId, promptNotValidAfter: later(promptId), ...extra } } as never, device);

    // The certified failure and its next boundary: Herdr accepts the
    // keystrokes, the answer is lost; the receipt must fence every retry.
    it('fences a side effect whose answer was lost, before and after a host restart, and replays refusals', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'muxr-prompts-'));
        const marker = join(dataDir, 'marker.txt');
        const source = {
            async prompt({ text }: { text: string }) {
                if (text.startsWith('refuse')) {
                    const error = new Error('That agent is no longer available. Refresh and try again.') as Error & { code: string };
                    error.code = 'agent-unavailable';
                    throw error;
                }
                appendFileSync(marker, `${text}\n`);
                // Herdr executed pane.send_input and then the socket timed out.
                if (text.startsWith('lost')) throw markPromptDispatched(new Error('herdr: request timed out'));
            },
        } as unknown as SessionSource;
        const dispatch = build(dataDir, source);
        const prompt = promptOf(dispatch);

        expect(await prompt('lost-1', 'lost answer', 'submission-0001')).toMatchObject({ ok: false, code: 'prompt-uncertain' });
        expect(await prompt('lost-2', 'lost answer', 'submission-0001')).toMatchObject({ ok: false, code: 'prompt-uncertain' });
        // Host restart: the ledger, not memory, still fences it.
        expect(await promptOf(build(dataDir, source))('lost-3', 'lost answer', 'submission-0001')).toMatchObject({ ok: false, code: 'prompt-uncertain' });
        expect(readFileSync(marker, 'utf8')).toBe('lost answer\n');

        // A refusal the host made before dispatch replays as the same refusal;
        // a deliberate new attempt is a new id.
        expect(await prompt('refuse-1', 'refuse me', 'submission-0002')).toMatchObject({ ok: false, code: 'agent-unavailable' });
        expect(await prompt('refuse-2', 'refuse me', 'submission-0002')).toMatchObject({ ok: false, code: 'agent-unavailable' });
        expect(await prompt('ok-1', 'printf once', 'submission-0003')).toMatchObject({ ok: true });
        expect(await prompt('ok-2', 'printf once', 'submission-0003')).toMatchObject({ ok: true });
        expect(await promptOf(build(dataDir, source))('ok-3', 'printf once', 'submission-0003')).toMatchObject({ ok: true });
        expect(readFileSync(marker, 'utf8')).toBe('lost answer\nprintf once\n');
    });

    it('joins in-flight duplicates immediately and refuses conflicting input, wrong ids, expiry and unidentified prompts', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'muxr-prompts-'));
        const executed: string[] = [];
        let release: (() => void) | undefined;
        const source = {
            async prompt({ text }: { text: string }) {
                executed.push(text);
                if (text === 'hang') await new Promise<void>((resolve) => { release = resolve; });
            },
        } as unknown as SessionSource;
        const dispatch = build(dataDir, source);
        const prompt = promptOf(dispatch);

        // No sleep between them: the duplicate joins before the fence is even on disk.
        const first = prompt('hang-1', 'hang', 'submission-0004');
        const duplicate = prompt('hang-2', 'hang', 'submission-0004');
        const conflict = prompt('hang-3', 'other text', 'submission-0004');
        expect(await conflict).toMatchObject({ ok: false, code: 'prompt-conflict' });
        // A restart while it hangs sees a started receipt: uncertain, never re-run.
        while (!existsSync(join(dataDir, 'prompt-receipts.json'))) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(await promptOf(build(dataDir, source))('hang-4', 'hang', 'submission-0004')).toMatchObject({ ok: false, code: 'prompt-uncertain' });
        release?.();
        expect(await first).toMatchObject({ ok: true });
        expect(await duplicate).toMatchObject({ ok: true });
        expect(executed).toEqual(['hang']);

        expect(await prompt('done', 'done', 'submission-0005')).toMatchObject({ ok: true });
        expect(await prompt('done-other-session', 'done', 'submission-0005', { sessionId: 's2' })).toMatchObject({ ok: false, code: 'prompt-conflict' });
        expect(await prompt('done-other-attachments', 'done', 'submission-0005', { attachments: [{ name: 'a', mimeType: 'text/plain', data: 'AA==' }] })).toMatchObject({ ok: false, code: 'prompt-conflict' });
        // Same id from another device is that device's own submission.
        expect(await promptOf(dispatch, 'native-2')('other-device', 'done', 'submission-0005')).toMatchObject({ ok: true });
        expect(executed).toEqual(['hang', 'done', 'done']);

        for (const bad of [12345678, ['submission-0006'], 'no', null]) {
            expect(await prompt('bad', 'x', bad)).toMatchObject({ ok: false, code: 'prompt-invalid' });
        }
        expect(await prompt('expired', 'x', 'submission-0007', { promptNotValidAfter: Date.now() - 1 })).toMatchObject({ ok: false, code: 'prompt-expired' });
        expect(await prompt('too-long', 'x', 'submission-0008', { promptNotValidAfter: Date.now() + 24 * 60 * 60_000 })).toMatchObject({ ok: false, code: 'prompt-invalid' });
        expect(await dispatch({ type: 'session.prompt', requestId: 'old-client', params: { sessionId: 's1', text: 'x' } } as never, 'browser-1')).toMatchObject({ ok: false, code: 'prompt-id-required' });
        expect(executed).toEqual(['hang', 'done', 'done']);
    });

    it('refuses at capacity without evicting protection and fails closed on a lost or corrupt ledger', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'muxr-prompts-'));
        const executed: string[] = [];
        const source = { async prompt({ text }: { text: string }) { executed.push(text); } } as unknown as SessionSource;
        const dispatch = build(dataDir, source);
        const prompt = promptOf(dispatch);
        expect(await prompt('a', 'A', 'submission-A000')).toMatchObject({ ok: true });
        for (let index = 1; index < 256; index += 1) {
            expect(await prompt(`fill-${index}`, `fill ${index}`, `submission-${String(index).padStart(4, '0')}`)).toMatchObject({ ok: true });
        }
        // The device is full: a new submission is refused, A stays protected,
        // and another device is unaffected.
        expect(await prompt('over', 'over', 'submission-over')).toMatchObject({ ok: false, code: 'prompt-capacity' });
        expect(await prompt('a-again', 'A', 'submission-A000')).toMatchObject({ ok: true });
        expect(await promptOf(dispatch, 'native-2')('other', 'other', 'submission-over')).toMatchObject({ ok: true });
        expect(executed.filter((text) => text === 'A')).toHaveLength(1);
        expect(executed.filter((text) => text === 'over')).toHaveLength(0);

        // The ledger vanishes but the initialised marker remains: history was
        // lost, so identified prompts are refused until every submission it
        // could have protected has expired — and nothing is re-run.
        const ledger = join(dataDir, 'prompt-receipts.json');
        const before = readFileSync(ledger, 'utf8');
        rmSync(ledger);
        expect(await promptOf(build(dataDir, source))('after-loss', 'A', 'submission-A000')).toMatchObject({ ok: false, code: 'prompt-history-lost' });
        while (!existsSync(ledger)) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(JSON.parse(readFileSync(ledger, 'utf8'))).toMatchObject({ quarantineUntil: expect.any(Number) });

        // A corrupt ledger fails every identified prompt closed and is never overwritten.
        writeFileSync(ledger, `${before.slice(0, 40)}garbage`);
        expect(await promptOf(build(dataDir, source))('corrupt', 'A', 'submission-A000')).toMatchObject({ ok: false, code: 'prompt-ledger-unreadable' });
        writeFileSync(ledger, JSON.stringify({ revision: 3, receipts: [{ deviceId: 'browser-1', promptId: 'submission-A000', requestHash: 'x', notValidAfter: later(), state: 'done' }] }));
        expect(await promptOf(build(dataDir, source))('invalid-entry', 'A', 'submission-A000')).toMatchObject({ ok: false, code: 'prompt-ledger-unreadable' });
        expect(readFileSync(ledger, 'utf8')).toContain('"requestHash":"x"');
        expect(executed.filter((text) => text === 'A')).toHaveLength(1);

        // Peers keep their own receipt boundary: no client identity needed.
        expect(await dispatch({ type: 'session.prompt', requestId: 'peer', params: { sessionId: 's1', text: 'peer prompt', peerMutation: { operationId: 'op', notValidAfter: later() } } } as never, 'peer-1')).toMatchObject({ ok: true });
    });
});
