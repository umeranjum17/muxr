import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHerdrSessionSource } from './herdrSessionSource.js';
import { createLifecycleStore } from './lifecycleStore.js';

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
    const calls: Array<{ method: string; target: string | undefined }> = [];
    let replaceDuringPrompt = false;
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
                            panes: ['w1:p1', 'w1:p2', 'w1:p3'].map((pane_id) => ({ pane_id, tab_id: 'w1:t1', workspace_id: 'w1', cwd: dir })),
                            agents: [
                                {
                                    pane_id: 'w1:p1',
                                    name: 'alpha',
                                    agent: 'claude',
                                    agent_status: 'working',
                                    interactive_ready: true,
                                    agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'claude-1' },
                                },
                                codex,
                            ],
                        },
                    };
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
                socket.end(`${JSON.stringify({ id, result })}\n`);
            }
        });
        socket.on('error', () => {});
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return { socketPath, codex, calls, replaceDuringPrompt: () => { replaceDuringPrompt = true; }, close: () => server.close() };
}

describe('Codex without a Herdr agent_session', () => {
    it('shows as an openable Codex agent and keeps its route once Herdr publishes the session', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-codex-'));
        const herdr = fakeHerdr(dir);
        const source = await createHerdrSessionSource({
            lifecycle: createLifecycleStore(join(dir, 'lifecycle')),
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
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
        } finally {
            await source.close();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});
