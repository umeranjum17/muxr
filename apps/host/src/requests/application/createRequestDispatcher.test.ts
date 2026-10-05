import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MISSING_CWD_ERROR_PREFIX, normalizeRequestFailure } from '@trymuxr/contract';
import { createRequestDispatcher } from './createRequestDispatcher.js';
import { agentToolPath, createFakeSessionSource, type SessionSource } from '../../agent/index.js';
import { hostPlatformLabel } from '../../machine/index.js';
import { HerdrKit } from '@byokit/herdr';
import { AgentCatalog } from './agentCatalog.js';

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
    it('threads confirmed scope to the close flow', async () => {
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
            options: { confirmedScope: 'tab' },
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
    it('reports installed agents and default-folder sign-in, caches checks, and refreshes after sign-in', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-catalog-'));
        const bin = join(home, '.local', 'bin');
        mkdirSync(bin, { recursive: true });
        const env = { ...process.env, HOME: home, PATH: join(home, 'empty-path'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
        const claude = join(bin, 'claude');
        writeFileSync(claude, `#!${process.execPath}
const fs = require('node:fs');
const loggedIn = !fs.existsSync(process.env.HOME + '/signed-out');
fs.appendFileSync(process.env.HOME + '/calls', process.env.CLAUDE_CONFIG_DIR + '\\n');
console.log(JSON.stringify({loggedIn, email: 'umer@example.test', plan: 'lab'}));
`);
        const codex = join(bin, 'codex');
        writeFileSync(codex, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    const reply = () => {
        if (request.id === 2 && fs.existsSync(process.env.HOME + '/hold-codex')) {
            fs.writeFileSync(process.env.HOME + '/codex-pending', '');
            setTimeout(reply, 10);
            return;
        }
        console.log(JSON.stringify({id: request.id, result: request.id === 1 ? {} : {account: null}}));
    };
    reply();
});
`);
        chmodSync(claude, 0o755);
        chmodSync(codex, 0o755);
        const kit = new HerdrKit({ mode: 'adopt', bin: 'herdr', socketPath: join(home, 'unused.sock') });
        const source = {
            async agentKinds() { return ['pi', 'claude', 'codex', 'grok']; },
            async installedAgentKinds(kinds: string[]) { return kit.installedAgentKinds(kinds, { path: agentToolPath(env) }); },
        } as unknown as SessionSource;
        const { dispatch, refreshAgentCatalog } = createRequestDispatcher({
            source,
            agentCatalog: new AgentCatalog(source, env),
            domain: {} as never,
            machineId: 'm1',
            machineName: 'Build Mac',
            hostVersion: '0.0.0',
        });
        try {
            const request = { type: 'herdr.agentKinds', requestId: 'catalog', params: {} } as const;
            const result = await dispatch(request, 'device-1');
            expect(result).toMatchObject({ ok: true, data: {
                kinds: ['pi', 'claude', 'codex', 'grok'], installed: ['claude', 'codex'],
                readiness: {
                    claude: { signedIn: 'yes' },
                    codex: { signedIn: 'no', signInHint: 'On your computer run `codex`, sign in, then check again.' },
                    pi: { signedIn: 'unknown', installHint: 'Installs on first start' },
                    grok: { signedIn: 'unknown' },
                },
            } });
            expect(JSON.stringify(result)).not.toMatch(/umer@example|email|plan|token/);
            writeFileSync(join(home, 'signed-out'), '');
            expect(await dispatch(request, 'device-2')).toEqual(result);
            expect(readFileSync(join(home, 'calls'), 'utf8')).toBe(join(home, '.claude') + '\n');
            await expect(dispatch({ ...request, params: { refresh: true } }, 'device-1'))
                .resolves.toMatchObject({ ok: true, data: { readiness: { claude: { signedIn: 'no' } } } });
            expect(readFileSync(join(home, 'calls'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
            writeFileSync(join(home, 'hold-codex'), '');
            refreshAgentCatalog();
            const background = dispatch(request, 'device-2');
            refreshAgentCatalog();
            await vi.waitFor(() => {
                expect(existsSync(join(home, 'codex-pending'))).toBe(true);
                expect(readFileSync(join(home, 'calls'), 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
            });
            rmSync(join(home, 'signed-out'));
            const refreshed = dispatch({ ...request, params: { refresh: true } }, 'device-1');
            rmSync(join(home, 'hold-codex'));
            await expect(background)
                .resolves.toMatchObject({ ok: true, data: { readiness: { claude: { signedIn: 'no' } } } });
            const afterSignIn = await refreshed;
            expect(afterSignIn).toMatchObject({ ok: true, data: { readiness: { claude: { signedIn: 'yes' } } } });
            expect(JSON.stringify(afterSignIn)).not.toMatch(/umer@example|email|plan|token/);
            expect(readFileSync(join(home, 'calls'), 'utf8').split('\n').filter(Boolean)).toHaveLength(4);
            expect(await dispatch(request, 'device-2')).toEqual(afterSignIn);
            writeFileSync(claude, `#!${process.execPath}\nconsole.log('status unavailable');\n`);
            await expect(dispatch({ ...request, params: { refresh: true } }, 'device-1'))
                .resolves.toMatchObject({ ok: true, data: { readiness: { claude: { signedIn: 'unknown' } } } });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
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

describe('voice device authority', () => {
    it('lets a view-only grant read the spoken report but never change voice state', async () => {
        const { dispatch } = createRequestDispatcher({
            source: createFakeSessionSource() as unknown as SessionSource,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            canMutateDevice: (deviceId) => deviceId !== 'viewer-1',
        });
        const report = await dispatch({
            type: 'voice.report',
            requestId: 'report',
            params: { displayName: 'Nia', taskTitle: 'Ship the report', status: 'done', outcome: 'done' },
        } as never, 'viewer-1');
        expect(report).toMatchObject({ ok: true });
        expect((report as { data: { say: string } }).data.say).toContain('Host-confirmed report');

        const key = await dispatch({
            type: 'voice.key.set',
            requestId: 'key',
            params: { key: 'not-a-real-key', provider: 'xai' },
        } as never, 'viewer-1');
        expect(key).toMatchObject({ ok: false, error: expect.stringContaining('view-only') });
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

// The artifact unification renamed attachment.* to artifact.*. A host has to
// keep answering an app built before the rename, with the shapes it expects.
describe('artifact wire across app versions', () => {
    const artifacts = [{ id: 'a'.repeat(64), name: 'report.md', mimeType: 'text/plain', size: 5, at: 1 }];
    const chunk = { id: 'a'.repeat(64), name: 'report.md', mimeType: 'text/plain', size: 5, offset: 0, data: 'aGVsbG8=' };
    const asked: string[] = [];

    async function dispatchArtifact(request: Record<string, unknown>, viewOnly = false) {
        const source = {
            async artifactList() { asked.push('artifactList'); return { artifacts, total: 1, truncated: false }; },
            async artifactFetch() { asked.push('artifactFetch'); return { name: 'report.md', mimeType: 'text/plain', data: 'aGVsbG8=' }; },
            async artifactPrepare() { asked.push('artifactPrepare'); return { token: 'one-time', name: 'report.md', mimeType: 'text/plain', size: 5 }; },
            async artifactRead() { asked.push('artifactRead'); return chunk; },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            relayUrl: 'wss://relay.test',
            canMutateDevice: () => !viewOnly,
        });
        return dispatch(request as never, viewOnly ? 'viewer-1' : undefined);
    }

    it('serves both spellings of every method, with the pre-rename shapes', async () => {
        const artifactId = 'a'.repeat(64);

        const modernList = await dispatchArtifact({ type: 'artifact.list', requestId: 'r1', params: { sessionId: 's1' } });
        expect(modernList).toMatchObject({ ok: true, data: { artifacts, total: 1, truncated: false } });

        const legacyList = await dispatchArtifact({ type: 'attachment.list', requestId: 'r2', params: { sessionId: 's1' } });
        expect(legacyList).toMatchObject({ ok: true, data: { attachments: artifacts, total: 1, truncated: false } });
        // A pre-rename listing carries no `artifacts` key.
        expect(Object.keys((legacyList as { data: object }).data)).toEqual(['attachments', 'total', 'truncated']);

        const pairs: [string, Record<string, unknown>][] = [
            ['attachment.fetch', { sessionId: 's1', attachmentId: artifactId }],
            ['attachment.prepare', { sessionId: 's1', attachmentId: artifactId }],
            ['attachment.read', { sessionId: 's1', attachmentId: artifactId, offset: 0, length: 512 }],
        ];
        const canonical: Record<string, unknown>[] = [
            { sessionId: 's1', artifactId },
            { sessionId: 's1', artifactId },
            { sessionId: 's1', artifactId, offset: 0, length: 512 },
        ];
        for (let index = 0; index < pairs.length; index += 1) {
            const [legacyType, legacyParams] = pairs[index]!;
            const modern = await dispatchArtifact({ type: legacyType.replace('attachment.', 'artifact.'), requestId: 'modern', params: canonical[index] });
            const legacy = await dispatchArtifact({ type: legacyType, requestId: 'legacy', params: legacyParams });
            expect(modern).toMatchObject({ ok: true });
            expect(legacy).toEqual({ ...(modern as object), requestId: 'legacy' });
        }

        // One implementation behind both names, so an alias can never drift.
        expect(asked).toEqual([
            'artifactList',
            'artifactList',
            'artifactFetch', 'artifactFetch',
            'artifactPrepare', 'artifactPrepare',
            'artifactRead', 'artifactRead',
        ]);
    });

    it('keeps the pre-rename read-only methods readable by a view-only grant', async () => {
        const listing = await dispatchArtifact({ type: 'attachment.list', requestId: 'r5', params: { sessionId: 's1' } }, true);
        expect(listing).toMatchObject({ ok: true });
    });
});

describe('desktop target routing', () => {
    it('sends a Watch tap at a session to its own screen, never the desktop', async () => {
        const calls: string[] = [];
        const opened = { desktopId: 'pv1', generation: 1, geometry: {}, source: {} };
        const desktop = {
            open: async () => { calls.push('desktop.open'); return { ...opened, desktopId: 'd1' }; },
            answer: async () => { calls.push('desktop.answer'); return { accepted: true }; },
        };
        const previewDesktops = {
            resolveTarget: async (sessionId: string) => {
                if (sessionId !== 'sess-1') {
                    const refused = new Error('that session has no screen to watch') as Error & { code: string };
                    refused.code = 'permission-denied';
                    throw refused;
                }
                return { paneId: 'pane-1', display: ':121' };
            },
            openTarget: async (sessionId: string) => {
                await previewDesktops.resolveTarget(sessionId);
                calls.push('preview.open');
                return opened;
            },
            owns: (desktopId: string) => desktopId === 'pv1',
            answer: async () => { calls.push('preview.answer'); return { accepted: true }; },
        };
        const source = { async list() { return [{ id: 'sess-1', paneId: 'pane-1' }]; } } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            desktop: desktop as never,
            previewDesktops: previewDesktops as never,
        });

        // A Watch tap names the session; it must open that pane's screen.
        const targeted = await dispatch({
            type: 'desktop.open', requestId: 'r1', params: { permissions: ['view'], target: { sessionId: 'sess-1' } },
        } as never);
        expect(targeted).toMatchObject({ ok: true, data: { desktopId: 'pv1' } });
        // Computer opens exactly as before when no target is named.
        const plain = await dispatch({ type: 'desktop.open', requestId: 'r2', params: { permissions: ['view'] } } as never);
        expect(plain).toMatchObject({ ok: true, data: { desktopId: 'd1' } });
        await dispatch({ type: 'desktop.answer', requestId: 'r3', params: { desktopId: 'pv1', sdp: 'x' } } as never);
        await dispatch({ type: 'desktop.answer', requestId: 'r4', params: { desktopId: 'd1', sdp: 'x' } } as never);
        // An unknown session is refused, never fallen back to the desktop.
        const refused = await dispatch({
            type: 'desktop.open', requestId: 'r5', params: { permissions: ['view'], target: { sessionId: 'nope' } },
        } as never);
        expect(refused).toMatchObject({ ok: false, code: 'permission-denied' });
        expect(calls).toEqual(['preview.open', 'desktop.open', 'preview.answer', 'desktop.answer']);
    });
});

describe('plan account launch and move', () => {
    const home = mkdtempSync(join(tmpdir(), 'muxr-plans-dispatch-'));
    const savedHome = process.env.HOME;
    const savedMuxrHome = process.env.MUXR_HOME;
    process.env.HOME = home;
    process.env.MUXR_HOME = join(home, 'muxr');

    const savedPath = process.env.PATH;
    beforeAll(() => {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'herdr'), `#!/bin/sh
exit 0
`, { mode: 0o755 });
        writeFileSync(join(bin, 'claude'), `#!/bin/sh
echo '{"loggedIn":true,"email":"work@example.com"}'
`, { mode: 0o755 });
        writeFileSync(join(bin, 'codex'), `#!/bin/sh
read line
echo '{"id":1,"result":{}}'
read line
echo '{"id":2,"result":{"account":{"email":"work@example.com"}}}'
`, { mode: 0o755 });
        process.env.PATH = `${bin}:${savedPath ?? ''}`;
    });
    afterAll(() => {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
    });

    it('starts on the stored account env, and refuses unknown ids, squads and kind mismatches', async () => {
        const { savePlanAccounts } = await import('../../plans/planStore.js');
        const folder = join(home, 'muxr', 'plans', 'claude', 'work');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(folder, { recursive: true });
        savePlanAccounts(process.env, [{ id: 'pa_work', provider: 'claude', name: 'Work', folder, found: false }]);
        const starts: unknown[] = [];
        const source = {
            async list() { return [{ id: 's1' }]; },
            async start(options: unknown) {
                starts.push(options);
                return { info: { id: 's1' }, acceptance: { outcome: 'accepted', state: 'starting', agentName: 'n' } };
            },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({ source, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });
        const cwd = mkdtempSync(join(tmpdir(), 'muxr-plan-start-'));

        const ok = await dispatch({ type: 'session.start', requestId: 'p1', params: { cwd, kind: 'claude', planAccount: 'pa_work' } } as never);
        expect(ok).toMatchObject({ ok: true });
        expect(starts[0]).toMatchObject({ planEnv: { CLAUDE_CONFIG_DIR: folder } });

        const unknown = await dispatch({ type: 'session.start', requestId: 'p2', params: { cwd, planAccount: 'nope' } } as never);
        expect(unknown).toMatchObject({ ok: false, code: 'unknown-plan-account' });

        const squad = await dispatch({ type: 'session.start', requestId: 'p3', params: { cwd, kinds: ['claude'], planAccount: 'pa_work' } } as never);
        expect(squad).toMatchObject({ ok: false, code: 'plan-squad-unsupported' });

        const mismatch = await dispatch({ type: 'session.start', requestId: 'p4', params: { cwd, kind: 'codex', planAccount: 'pa_work' } } as never);
        expect(mismatch).toMatchObject({ ok: false, code: 'plan-kind-mismatch' });
        expect(starts).toHaveLength(1);

        process.env.HOME = savedHome;
        if (savedMuxrHome === undefined) delete process.env.MUXR_HOME;
        else process.env.MUXR_HOME = savedMuxrHome;
    });

    it('drops client-supplied planEnv so only the stored account env reaches the pane', async () => {
        const { savePlanAccounts } = await import('../../plans/planStore.js');
        const home3 = mkdtempSync(join(tmpdir(), 'muxr-plans-env-'));
        const keepHome = process.env.HOME;
        const keepMuxr = process.env.MUXR_HOME;
        process.env.HOME = home3;
        process.env.MUXR_HOME = join(home3, 'muxr');
        try {
            const { mkdirSync } = await import('node:fs');
            const folder = join(home3, 'muxr', 'plans', 'claude', 'work');
            mkdirSync(folder, { recursive: true });
            savePlanAccounts(process.env, [{ id: 'pa_work', provider: 'claude', name: 'Work', folder, found: false }]);
            const starts: unknown[] = [];
            const source = {
                async list() { return [{ id: 's1' }]; },
                async start(options: unknown) {
                    starts.push(options);
                    return { info: { id: 's1' }, acceptance: { outcome: 'accepted', state: 'starting', agentName: 'n' } };
                },
            } as unknown as SessionSource;
            const { dispatch } = createRequestDispatcher({ source, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });
            const cwd = mkdtempSync(join(tmpdir(), 'muxr-plan-env-start-'));

            const bare = await dispatch({ type: 'session.start', requestId: 'e1', params: { cwd, kind: 'claude', planEnv: { PATH: '/evil', CLAUDE_CONFIG_DIR: '/evil' } } } as never);
            expect(bare).toMatchObject({ ok: true });
            expect(starts[0]).not.toHaveProperty('planEnv');

            const ok = await dispatch({ type: 'session.start', requestId: 'e2', params: { cwd, kind: 'claude', planAccount: 'pa_work', planEnv: { CLAUDE_CONFIG_DIR: '/evil' } } } as never);
            expect(ok).toMatchObject({ ok: true });
            expect(starts[1]).toMatchObject({ planEnv: { CLAUDE_CONFIG_DIR: folder } });
        } finally {
            if (keepHome === undefined) delete process.env.HOME;
            else process.env.HOME = keepHome;
            if (keepMuxr === undefined) delete process.env.MUXR_HOME;
            else process.env.MUXR_HOME = keepMuxr;
        }
    });

    it('keeps account moves exclusive through persistence and names the account when the start fails', async () => {
        const { savePlanAccounts } = await import('../../plans/planStore.js');
        const home2 = mkdtempSync(join(tmpdir(), 'muxr-plans-move-'));
        const keepHome = process.env.HOME;
        const keepMuxr = process.env.MUXR_HOME;
        process.env.HOME = home2;
        process.env.MUXR_HOME = join(home2, 'muxr');
        try {
            savePlanAccounts(process.env, [{ id: 'pa_w', provider: 'codex', name: 'Work', folder: join(home2, 'c'), found: false }]);
            const moves: unknown[] = [];
            let finishMove!: () => void;
            const moveFinished = new Promise<void>((resolve) => { finishMove = resolve; });
            let moveStarted!: () => void;
            const moveStarting = new Promise<void>((resolve) => { moveStarted = resolve; });
            let finishPersistence!: () => void;
            const persistenceFinished = new Promise<void>((resolve) => { finishPersistence = resolve; });
            let persistenceStarted!: () => void;
            const persistenceStarting = new Promise<void>((resolve) => { persistenceStarted = resolve; });
            const source = {
                async movePlanAccount(options: unknown) {
                    moves.push(options);
                    moveStarted();
                    await moveFinished;
                    return { sessionId: 's2' };
                },
                async list() {
                    persistenceStarted();
                    await persistenceFinished;
                    return [{ id: 's2', paneId: 'w1:p2' }];
                },
            } as unknown as SessionSource;
            const { dispatch } = createRequestDispatcher({ source, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });
            const moving = dispatch({ type: 'plans.move', requestId: 'm1', params: { sessionId: 's1', accountId: 'pa_w' } });
            await moveStarting;
            expect(await dispatch({ type: 'plans.move', requestId: 'overlap', params: { sessionId: 'other-agent', accountId: 'pa_w' } }))
                .toMatchObject({ ok: false, code: 'plan-move-in-progress', error: 'Another move is in progress.' });
            finishMove();
            await persistenceStarting;
            expect(await dispatch({ type: 'plans.move', requestId: 'persisting', params: { sessionId: 's2', accountId: 'pa_w' } }))
                .toMatchObject({ ok: false, code: 'plan-move-in-progress', error: 'Another move is in progress.' });
            finishPersistence();
            expect(await moving).toMatchObject({ ok: true, data: { sessionId: 's2' } });
            expect(moves).toHaveLength(1);
            expect(moves[0]).toMatchObject({ sessionId: 's1', provider: 'codex' });
            expect(await dispatch({ type: 'plans.agent', requestId: 'current', params: { sessionId: 's2' } }))
                .toMatchObject({ ok: true, data: { accountId: 'pa_w' } });
            expect(await dispatch({ type: 'plans.move', requestId: 'next', params: { sessionId: 's2', accountId: 'pa_w' } }))
                .toMatchObject({ ok: true });
            expect(moves).toHaveLength(2);

            const failing = {
                async movePlanAccount() {
                    throw Object.assign(new Error('The agent did not start on the new account.'), { code: 'plan-move-start-failed' });
                },
            } as unknown as SessionSource;
            const { dispatch: dispatchFailing } = createRequestDispatcher({ source: failing, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });
            const failed = await dispatchFailing({ type: 'plans.move', requestId: 'm2', params: { sessionId: 's1', accountId: 'pa_w' } });
            expect(failed).toMatchObject({ ok: false, code: 'plan-move-start-failed' });
            expect(String((failed as { error: string }).error)).toContain("Couldn't start on Work");
            expect(failed).not.toHaveProperty('sessionId');

            const exposed = {
                async movePlanAccount() {
                    throw Object.assign(new Error('The move did not finish. An extra copy is open; you can close it from its pane.'), {
                        code: 'plan-move-extra-copy', paneId: 'w1:p3',
                    });
                },
                async list() { return [{ id: 'moved', paneId: 'w1:p2' }, { id: 'extra', paneId: 'w1:p3' }]; },
            } as unknown as SessionSource;
            const { dispatch: dispatchExposed } = createRequestDispatcher({ source: exposed, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });
            const unfinished = await dispatchExposed({ type: 'plans.move', requestId: 'm3', params: { sessionId: 'moved', accountId: 'pa_w' } });
            expect(unfinished).toMatchObject({ ok: false, code: 'plan-move-extra-copy' });
            expect(unfinished).not.toHaveProperty('paneId');
            expect(await dispatchExposed({ type: 'plans.agent', requestId: 'a1', params: { sessionId: 'extra' } }))
                .toMatchObject({ ok: true, data: { accountId: 'pa_w' } });
            expect(await dispatchExposed({ type: 'plans.agent', requestId: 'a2', params: { sessionId: 'moved' } }))
                .toMatchObject({ ok: true, data: { accountId: 'pa_w' } });
        } finally {
            if (keepHome === undefined) delete process.env.HOME;
            else process.env.HOME = keepHome;
            if (keepMuxr === undefined) delete process.env.MUXR_HOME;
            else process.env.MUXR_HOME = keepMuxr;
        }
    });

    it('keeps sign-in tabs closable: id fallback, stale-tab close, failed-launch cleanup', async () => {
        const { loadPlanAccounts, savePlanAccounts } = await import('../../plans/planStore.js');
        const home4 = mkdtempSync(join(tmpdir(), 'muxr-plans-signin-'));
        const keepHome = process.env.HOME;
        const keepMuxr = process.env.MUXR_HOME;
        process.env.HOME = home4;
        process.env.MUXR_HOME = join(home4, 'muxr');
        try {
            savePlanAccounts(process.env, [{ id: 'pa_s', provider: 'claude', name: 'Side', folder: join(home4, 'c'), found: false }]);
            const sessions: Array<{ id: string; paneId: string }> = [];
            const stopped: string[] = [];
            let launches = 0;
            let closeUnavailable = false;
            let lastStart: { signIn?: string; planEnv?: Record<string, string> } = {};
            const source = {
                async start(command: { signIn?: string; planEnv?: Record<string, string> }) {
                    lastStart = command;
                    launches += 1;
                    // The first launch reports no paneId at all, like a source that only knows the tab id.
                    const info = launches === 1 ? { id: 'tab-1' } : { id: `tab-${launches}`, paneId: `w9:p${launches}` };
                    sessions.push({ id: info.id, paneId: (info as { paneId?: string }).paneId ?? info.id });
                    return { info };
                },
                async list() { return sessions.map((session) => ({ ...session })); },
                async stop(id: string) {
                    if (closeUnavailable) return { status: 'retryable', message: 'Try again.' };
                    stopped.push(id);
                    const at = sessions.findIndex((session) => session.id === id);
                    if (at >= 0) sessions.splice(at, 1);
                    return { status: 'closed' };
                },
            } as unknown as SessionSource;
            const { dispatch } = createRequestDispatcher({ source, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });

            // Pane-id fallback: the tab is still found by its session id and closed on cancel.
            const added = await dispatch({ type: 'plans.add', requestId: 'a1', params: { provider: 'claude', accountId: 'pa_s' } });
            expect(added).toMatchObject({ ok: true });

            // The tab shows only the provider's sign-in: no folder, no marker on its command line.
            expect(lastStart.signIn).toBe(' sh "$MUXR_PLAN_SIGNIN"');
            const script = lastStart.planEnv!.MUXR_PLAN_SIGNIN!;
            expect(readFileSync(script, 'utf8')).toContain(`CLAUDE_CONFIG_DIR='${join(home4, 'c')}'`);
            // A login that fails ends the wait with why, instead of polling forever.
            const bin = join(home4, 'bin');
            mkdirSync(bin);
            writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
            execFileSync('sh', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
            const failedLogin = await dispatch({ type: 'plans.status', requestId: 's1', params: { accountId: 'pa_s' } });
            expect(failedLogin).toMatchObject({ ok: true, data: { account: { signedIn: false }, failure: expect.stringContaining('ended without signing in') } });
            closeUnavailable = true;
            expect(await dispatch({ type: 'plans.cancel', requestId: 'c0', params: { accountId: 'pa_s' } })).toMatchObject({ ok: false });
            expect(sessions).toHaveLength(1);
            closeUnavailable = false;
            const cancelled = await dispatch({ type: 'plans.cancel', requestId: 'c1', params: { accountId: 'pa_s' } });
            expect(stopped).toEqual(['tab-1']);
            expect(cancelled).toMatchObject({ ok: true, data: { removed: false } });

            // A second sign-in closes the still-open first tab before tracking the new one.
            await Promise.all([
                dispatch({ type: 'plans.add', requestId: 'a2', params: { provider: 'claude', accountId: 'pa_s' } }),
                dispatch({ type: 'plans.add', requestId: 'a3', params: { provider: 'claude', accountId: 'pa_s' } }),
            ]);
            expect(stopped).toEqual(['tab-1', 'tab-2']);
            // Closing the tab by hand is a failure the phone can show, not a silent wait.
            sessions.splice(0, sessions.length);
            const closedTab = await dispatch({ type: 'plans.status', requestId: 's2', params: { accountId: 'pa_s' } });
            expect(closedTab).toMatchObject({ ok: true, data: { failure: 'The sign-in tab was closed before you signed in.' } });
            await dispatch({ type: 'plans.cancel', requestId: 'c2', params: { accountId: 'pa_s' } });
            expect(stopped).toEqual(['tab-1', 'tab-2']);

            // A launch that fails after creating the record leaves no phantom behind.
            let failedStarts = 0;
            let createdFolder: string | undefined;
            let folderPresentAtStart = false;
            let recordsAtStart: string[] = [];
            const failing = {
                async start() {
                    failedStarts += 1;
                    const records = loadPlanAccounts(process.env);
                    recordsAtStart = records.map((record) => record.id);
                    createdFolder = records.find((record) => record.id !== 'pa_s')?.folder;
                    folderPresentAtStart = createdFolder !== undefined && existsSync(createdFolder);
                    throw new Error('herdr is down');
                },
            } as unknown as SessionSource;
            const { dispatch: dispatchFailing } = createRequestDispatcher({ source: failing, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });
            const failed = await dispatchFailing({ type: 'plans.add', requestId: 'a4', params: { provider: 'claude' } });
            expect(failed).toMatchObject({ ok: false });
            expect(failedStarts).toBe(1);
            expect(recordsAtStart).toHaveLength(2);
            expect(recordsAtStart).toContain('pa_s');
            expect(folderPresentAtStart).toBe(true);
            expect(loadPlanAccounts(process.env).map((record) => record.id)).toEqual(['pa_s']);
            expect(existsSync(createdFolder!)).toBe(false);
        } finally {
            if (keepHome === undefined) delete process.env.HOME;
            else process.env.HOME = keepHome;
            if (keepMuxr === undefined) delete process.env.MUXR_HOME;
            else process.env.MUXR_HOME = keepMuxr;
        }
    });

    it('records the Auto terms acknowledgment the one-time note needs', async () => {
        const { autoTermsAcknowledged } = await import('../../plans/planStore.js');
        const home3 = mkdtempSync(join(tmpdir(), 'muxr-plans-terms-'));
        const keepHome = process.env.HOME;
        const keepMuxr = process.env.MUXR_HOME;
        process.env.HOME = home3;
        process.env.MUXR_HOME = join(home3, 'muxr');
        try {
            const source = {} as unknown as SessionSource;
            const { dispatch } = createRequestDispatcher({ source, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });
            expect(autoTermsAcknowledged(process.env)).toBe(false);
            const acked = await dispatch({ type: 'plans.acknowledgeAutoTerms', requestId: 't1', params: {} });
            expect(acked).toMatchObject({ ok: true, data: { acknowledged: true } });
            expect(autoTermsAcknowledged(process.env)).toBe(true);
        } finally {
            if (keepHome === undefined) delete process.env.HOME;
            else process.env.HOME = keepHome;
            if (keepMuxr === undefined) delete process.env.MUXR_HOME;
            else process.env.MUXR_HOME = keepMuxr;
        }
    });
});

describe('android emulator target routing', () => {
    it('stamps the emulator chip and routes a Watch tap at its mirror, never the desktop', async () => {
        const calls: string[] = [];
        const opened = { desktopId: 'av1', generation: 1, geometry: {}, source: {} };
        const desktop = {
            open: async () => { calls.push('desktop.open'); return { desktopId: 'd1', generation: 1, geometry: {}, source: {} }; },
            answer: async () => { calls.push('desktop.answer'); return { accepted: true }; },
        };
        const androidTargets = {
            resolveTarget: async (sessionId: string) => {
                if (sessionId !== 'sess-1') {
                    const refused = new Error('that session has no emulator to watch') as Error & { code: string };
                    refused.code = 'permission-denied';
                    throw refused;
                }
                return { paneId: 'pane-1', serial: 'emulator-5662' };
            },
            openTarget: async (sessionId: string) => {
                await androidTargets.resolveTarget(sessionId);
                calls.push('android.open');
                return opened;
            },
            owns: (desktopId: string) => desktopId === 'av1',
            answer: async () => { calls.push('android.answer'); return { accepted: true }; },
            candidate: async () => { calls.push('android.candidate'); return { accepted: true }; },
            poll: async () => { calls.push('android.poll'); return { cursor: 1, events: [] }; },
            close: async () => { calls.push('android.close'); return { closed: true }; },
        };
        const source = { async list() { return [{ id: 'sess-1', paneId: 'pane-1' }]; } } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source: source as never,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            desktop: desktop as never,
            deviceTargets: [androidTargets as never],
            devicePreviewForPane: (paneId: string) => paneId === 'pane-1'
                ? { kind: 'android', title: 'Medium Phone', since: 1 }
                : undefined,
        });

        // The chip rides the session list.
        const listed = await dispatch({ type: 'session.list', requestId: 'r0', params: {} } as never);
        expect(listed).toMatchObject({ ok: true, data: [{ id: 'sess-1', preview: { kind: 'android', title: 'Medium Phone' } }] });
        // A Watch tap at the session opens its mirror.
        const targeted = await dispatch({
            type: 'desktop.open', requestId: 'r1', params: { permissions: ['view'], target: { sessionId: 'sess-1' } },
        } as never);
        expect(targeted).toMatchObject({ ok: true, data: { desktopId: 'av1' } });
        // Computer opens exactly as before when no target is named.
        const plain = await dispatch({ type: 'desktop.open', requestId: 'r2', params: { permissions: ['view'] } } as never);
        expect(plain).toMatchObject({ ok: true, data: { desktopId: 'd1' } });
        // Later signaling routes back to the mirror by its handle.
        await dispatch({ type: 'desktop.answer', requestId: 'r3', params: { desktopId: 'av1', sdp: 'x' } } as never);
        await dispatch({ type: 'desktop.candidate', requestId: 'r4', params: { desktopId: 'av1', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } } as never);
        await dispatch({ type: 'desktop.poll', requestId: 'r5', params: { desktopId: 'av1', cursor: 0 } } as never);
        await dispatch({ type: 'desktop.close', requestId: 'r6', params: { desktopId: 'av1' } } as never);
        await dispatch({ type: 'desktop.answer', requestId: 'r7', params: { desktopId: 'd1', sdp: 'x' } } as never);
        // An unknown session is refused, never fallen back to the desktop.
        const refused = await dispatch({
            type: 'desktop.open', requestId: 'r8', params: { permissions: ['view'], target: { sessionId: 'nope' } },
        } as never);
        expect(refused).toMatchObject({ ok: false, code: 'permission-denied' });
        expect(calls).toEqual([
            'android.open', 'desktop.open',
            'android.answer', 'android.candidate', 'android.poll', 'android.close',
            'desktop.answer',
        ]);
    });
});

describe('host error propagation to the phone', () => {
    it('returns a thrown handler failure as a typed error the phone decodes to the same message', async () => {
        const source = {
            async paneSplit() { throw new Error('that pane is gone; refresh and try again'); },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
        });
        const reply = await dispatch({
            type: 'pane.split', requestId: 'e1', params: { sessionId: 's1' },
        } as never) as { ok: boolean; error: string; code?: string };
        expect(reply.ok).toBe(false);
        expect(reply.code).toBe('host-error');
        // The phone's shared decode path (linkFirstClient unwrap) resolves to this message.
        const decoded = normalizeRequestFailure('pane.split', reply.error, reply.code);
        expect(decoded.message).toContain('that pane is gone');
    });

    it('redacts secrets from a thrown failure instead of forwarding them', async () => {
        const source = {
            async paneSplit() { throw new Error('login failed with token=abc123-secret'); },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
        });
        const reply = await dispatch({
            type: 'pane.split', requestId: 'e2', params: { sessionId: 's1' },
        } as never) as { ok: boolean; error: string };
        expect(reply.ok).toBe(false);
        expect(reply.error).not.toContain('abc123-secret');
        expect(reply.error).toContain('[redacted]');
    });
});

describe('dispatcher close', () => {
    it('cascades to the session source dispose', async () => {
        let disposed = 0;
        const source = { async dispose() { disposed += 1; } } as unknown as SessionSource;
        const dispatcher = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
        });
        await dispatcher.close();
        expect(disposed).toBe(1);
    });
});
