import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createHerdrSessionSource } from './herdrSessionSource.js';
import { createRequestDispatcher } from '../../requests/index.js';
import { createAgentWatchStores } from '../application/watchStores.js';

/**
 * Codex 0.159 runs under Herdr with no agent_session and no interactive_ready.
 * Herdr's agent field alone must make it an openable Codex agent, and the route
 * the phone opened must survive Herdr publishing the session later.
 */
function fakeHerdr(dir: string) {
    const codex: Record<string, unknown> = {
        pane_id: 'w1:p2',
        name: 'mike',
        agent: 'codex',
        agent_status: 'working',
        agent_session: null,
        interactive_ready: null,
    };
    const alpha = {
        pane_id: 'w1:p1', name: 'alpha', agent: 'claude', agent_status: 'working', interactive_ready: true,
        agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'claude-1' },
    };
    const calls: Array<{ method: string; target: string | undefined }> = [];
    let currentCwd = dir;
    let replaceDuringPrompt = false;
    let replaceDuringRead = false;
    let holdSnapshots = false;
    const heldSnapshots: Array<() => void> = [];
    const server = createServer((socket: Socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method, params } = JSON.parse(line) as { id: string; method: string; params?: { target?: string } };
                calls.push({ method, target: params?.target });
                if (method === 'events.subscribe') {
                    socket.write(`${JSON.stringify({ id, result: {} })}\n`);
                    continue;
                }
                let result: unknown = {};
                if (method === 'ping') result = { protocol: 22 };
                if (method === 'session.snapshot') {
                    result = {
                        snapshot: {
                            workspaces: [{ workspace_id: 'w1', label: 'byk' }],
                            tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1' }],
                            panes: ['w1:p1', 'w1:p2', 'w1:p3'].map((pane_id) => ({ pane_id, tab_id: 'w1:t1', workspace_id: 'w1', cwd: currentCwd })),
                            agents: [alpha, codex],
                        },
                    };
                }
                if (method === 'agent.get') result = { agent: {
                    ...(params?.target === 'w1:p2' ? codex : alpha), tab_id: 'w1:t1', workspace_id: 'w1', cwd: currentCwd,
                } };
                if (method === 'pane.get') result = { pane: { ...codex, tab_id: 'w1:t1', workspace_id: 'w1', cwd: currentCwd } };
                if (method === 'pane.read') {
                    result = { read: { text: 'Umer passive read proof', truncated: false } };
                    if (replaceDuringRead) {
                        replaceDuringRead = false;
                        codex.agent_session = { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'replaced-during-read' };
                    }
                }
                if (method === 'agent.prompt') {
                    if (replaceDuringPrompt) {
                        replaceDuringPrompt = false;
                        codex.agent_session = { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'replacement' };
                    }
                    result = { type: 'agent_prompted', agent: { ...codex,
                        terminal_id: 'codex-terminal', workspace_id: 'w1', tab_id: 'w1:t1',
                        focused: false, revision: 1 } };
                }
                const response = `${JSON.stringify({ id, result })}\n`;
                if (method === 'session.snapshot' && holdSnapshots) heldSnapshots.push(() => socket.end(response));
                else socket.end(response);
            }
        });
        socket.on('error', () => {});
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return {
        socketPath, codex, calls,
        setCwd: (cwd: string) => { currentCwd = cwd; },
        replaceDuringPrompt: () => { replaceDuringPrompt = true; },
        replaceDuringRead: () => { replaceDuringRead = true; },
        holdSnapshots: () => { holdSnapshots = true; },
        releaseSnapshots: () => { holdSnapshots = false; for (const respond of heldSnapshots.splice(0)) respond(); },
        waitingSnapshots: () => heldSnapshots.length,
        close: () => server.close(),
    };
}

describe('Codex without a Herdr agent_session', () => {
    it('shows as an openable Codex agent and keeps its route once Herdr publishes the session', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-codex-'));
        execFileSync('git', ['init', '--quiet', dir]);
        const herdr = fakeHerdr(dir);
        const domain = createAgentWatchStores({ dataDir: join(dir, 'host') });
        const source = await createHerdrSessionSource({
            lifecycle: domain.lifecycle,
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        const dispatcher = createRequestDispatcher({ source, domain, machineId: 'cwd-proof', hostVersion: '0.0.0' });
        const pane = async (paneId: string) => (await source.herdrTree()).workspaces[0]!.tabs[0]!.panes.find((p) => p.paneId === paneId)!;
        try {
            const codex = await pane('w1:p2');
            expect(codex).toMatchObject({ agentKind: 'codex', agentName: 'mike', agentStatus: 'working', promptable: true });
            expect(codex.sessionId).toMatch(/^pp_/);
            expect((await pane('w1:p1')).agentKind).toBe('claude');
            expect((await pane('w1:p3')).agentKind).toBeUndefined();
            expect((await source.list()).find((s) => s.id === codex.sessionId)?.agentKind).toBe('codex');
            await expect(source.open({ sessionId: codex.sessionId!, acknowledgeAttention: false })).resolves.toBeDefined();

            herdr.codex.agent_session = { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'codex-1' };
            await source.refreshHerdr();
            expect((await pane('w1:p2')).sessionId).toBe(codex.sessionId);

            // Observing one known route must not wait behind a full-tree read.
            // Keep the actual kit/socket refresh held, not a mocked source method.
            herdr.holdSnapshots();
            const refreshing = source.refreshHerdr();
            void refreshing.catch(() => {});
            const movedCwd = join(dir, 'moved');
            mkdirSync(movedCwd);
            execFileSync('git', ['init', '--quiet', movedCwd]);
            writeFileSync(join(movedCwd, 'CURRENT.md'), 'task-private CWD proof\n');
            let freshFiles: ReturnType<typeof dispatcher.dispatch> | undefined;
            try {
                await vi.waitFor(() => expect(herdr.waitingSnapshots()).toBeGreaterThan(0));
                const reads = Promise.all([
                    source.list(),
                    source.open({ sessionId: codex.sessionId!, acknowledgeAttention: false }),
                    source.paneRead({ sessionId: codex.sessionId! }),
                    source.status(codex.sessionId!),
                ]);
                let settled = false;
                void reads.then(() => { settled = true; }, () => { settled = true; });
                await vi.waitFor(() => expect(settled).toBe(true), { timeout: 10_000 });
                const [listed, opened, text, status] = await reads;
                expect(listed.some((session) => session.id === codex.sessionId)).toBe(true);
                expect(opened.info.id).toBe(codex.sessionId);
                expect(text.text).toBe('Umer passive read proof');
                expect(status.agentStatus).toBe('working');
                await vi.waitFor(() => expect(herdr.waitingSnapshots()).toBeGreaterThan(0));
                // Operation context must read after its call, not reuse the
                // earlier held snapshot or the UI's last-known directory.
                herdr.setCwd(movedCwd);
                freshFiles = dispatcher.dispatch({
                    type: 'files.list', requestId: 'fresh-operation', params: { sessionId: codex.sessionId! },
                });
                void freshFiles.catch(() => {});
            } finally {
                herdr.releaseSnapshots();
            }
            await refreshing;
            expect(await freshFiles).toMatchObject({ ok: true, data: {
                root: movedCwd, tree: expect.arrayContaining([expect.objectContaining({ name: 'CURRENT.md' })]),
            } });

            // Opening the live roster has already resolved the named agent, and
            // Herdr's receipt names the conversation it reached: no further read.
            herdr.calls.length = 0;
            await source.prompt({ sessionId: codex.sessionId!, text: 'Check the build.' });
            expect(herdr.calls.filter((call) => call.method === 'session.snapshot')).toHaveLength(0);
            expect(herdr.calls.filter((call) => call.method === 'agent.prompt')).toEqual([
                { method: 'agent.prompt', target: 'w1:p2' },
            ]);

            // A conversation replaced before the prompt lands, with no event yet:
            // the receipt names the replacement, so the fresh confirmation runs.
            herdr.calls.length = 0;
            herdr.replaceDuringPrompt();
            await expect(source.prompt({ sessionId: codex.sessionId!, text: 'Continue.' }))
                .rejects.toMatchObject({ code: 'prompt-outcome-unknown' });
            expect(herdr.calls.filter((call) => call.method === 'session.snapshot')).toHaveLength(1);
            expect(herdr.calls.filter((call) => call.method === 'agent.prompt')).toHaveLength(1);

            // The old route cannot send another prompt after confirmation sees
            // the replacement conversation.
            herdr.calls.length = 0;
            await expect(source.prompt({ sessionId: codex.sessionId!, text: 'Private follow-up.' }))
                .rejects.toMatchObject({ code: 'prompt-not-sent' });
            expect(herdr.calls.some((call) => call.method === 'session.snapshot')).toBe(true);
            expect(herdr.calls.filter((call) => call.method === 'agent.prompt')).toHaveLength(0);

            // Read the replacement's own route; a second replacement during the
            // read, with no event yet, must still invalidate the returned text.
            const replacement = await pane('w1:p2');
            herdr.replaceDuringRead();
            await expect(source.paneRead({ sessionId: replacement.sessionId! })).rejects.toMatchObject({ code: 'agent-unavailable' });
        } finally {
            await dispatcher.close();
            await source.close();
            await domain.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});
