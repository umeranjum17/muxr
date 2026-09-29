import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHerdrSessionSource } from './herdrSessionSource.js';

/**
 * The slice of herdr a plan-account move touches. `agent.start` publishes the
 * resumed conversation id straight from its resume args, the way a resume
 * reattaches to the same conversation; the first start can be failed to drive
 * the rollback path.
 */
function fakeHerdr(dir: string, cwd: string) {
    const workspaces = [{ workspace_id: 'w1', label: cwd }];
    const tabs: Record<string, unknown>[] = [{ tab_id: 't1', workspace_id: 'w1', label: 'main' }];
    const panes: Record<string, unknown>[] = [
        { pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd, env: { CLAUDE_CONFIG_DIR: '/orig/claude' }, output: [] as string[] },
    ];
    const agents: Record<string, unknown>[] = [
        {
            pane_id: 'p1',
            agent: 'claude',
            name: 'ram',
            agent_status: 'idle',
            interactive_ready: true,
            agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'claude-1' },
        },
    ];
    const state = { failNextStart: false };
    const calls: Array<{ method: string; detail: string }> = [];
    const splits: Array<{ target: unknown; env: unknown }> = [];
    let next = 2;
    const server = createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method, params } = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
                if (method === 'events.subscribe') {
                    socket.write(`${JSON.stringify({ id, result: {} })}\n`);
                    continue;
                }
                const p = params ?? {};
                let reply: unknown;
                switch (method) {
                    case 'session.snapshot':
                        reply = { id, result: { snapshot: structuredClone({ workspaces, tabs, panes, agents }) } };
                        break;
                    case 'plugin.list':
                        reply = { id, result: { plugins: [] } };
                        break;
                    case 'pane.split': {
                        const pane_id = `p${next++}`;
                        const pane = { pane_id, tab_id: 't1', workspace_id: 'w1', cwd, env: p.env, output: [] as string[] };
                        panes.push(pane);
                        splits.push({ target: p.target_pane_id, env: p.env });
                        calls.push({ method, detail: String(p.target_pane_id) });
                        reply = { id, result: { pane: { pane_id } } };
                        break;
                    }
                    case 'pane.send_text': {
                        const pane = panes.find((row) => row.pane_id === p.pane_id);
                        if (pane !== undefined) (pane.output as string[]).push(String(p.text));
                        reply = { id, result: {} };
                        break;
                    }
                    case 'pane.read': {
                        const pane = panes.find((row) => row.pane_id === p.pane_id);
                        const output = ((pane?.output ?? []) as string[]).join('');
                        const echo = output.split('\n').reverse().find((entry) => entry.startsWith('echo '));
                        const parsed = /echo (\S+)=\$(\S+)/.exec(echo ?? '');
                        const text = parsed === null
                            ? output
                            : `${output}\n${parsed[1]}=${String((pane?.env as Record<string, string> ?? {})[parsed[2]!] ?? '')}\n`;
                        reply = { id, result: { read: { text } } };
                        break;
                    }
                    case 'pane.close': {
                        calls.push({ method, detail: String(p.pane_id) });
                        const at = panes.findIndex((row) => row.pane_id === p.pane_id);
                        if (at >= 0) panes.splice(at, 1);
                        for (let i = agents.length - 1; i >= 0; i -= 1) {
                            if (agents[i]!.pane_id === p.pane_id) agents.splice(i, 1);
                        }
                        reply = { id, result: {} };
                        break;
                    }
                    case 'pane.report_metadata':
                        reply = { id, result: {} };
                        break;
                    case 'agent.start': {
                        calls.push({ method, detail: String(p.pane_id) });
                        if (state.failNextStart) {
                            state.failNextStart = false;
                            reply = { id, error: { code: 'start_failed', message: 'agent.start failed' } };
                            break;
                        }
                        const args = (p.args ?? []) as string[];
                        const resumeAt = args.findIndex((arg) => arg === '--resume' || arg === 'resume' || arg === '--session');
                        const value = resumeAt >= 0 ? String(args[resumeAt + 1]) : String(p.name);
                        const kind = args[resumeAt] === '--session' ? 'path' : 'id';
                        const agent = {
                            pane_id: p.pane_id,
                            name: p.name,
                            agent: p.kind,
                            agent_status: 'idle',
                            interactive_ready: true,
                            agent_session: { source: 'herdr', agent: p.kind, kind, value },
                        };
                        agents.push(agent);
                        reply = { id, result: { agent } };
                        break;
                    }
                    case 'agent.wait': {
                        const agent = agents.find((row) => row.pane_id === p.target);
                        reply = { id, result: { agent: agent === undefined ? {} : { ...agent, interactive_ready: true } } };
                        break;
                    }
                    default:
                        reply = { id, error: { code: 'method_not_found', message: method } };
                        break;
                }
                socket.end(`${JSON.stringify(reply)}\n`);
            }
        });
        socket.on('error', () => {});
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return {
        socketPath,
        state,
        agents,
        panes,
        splits,
        calls,
        close(): void {
            server.close();
        },
    };
}

describe('a plan-account move whose new-account start fails', () => {
    it('keeps close-before-start, resumes the same conversation on the original account, and names the live session', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-move-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            await source.refreshHerdr();
            const listed = await source.list();
            expect(listed).toHaveLength(1);
            const sessionId = listed[0]!.id;

            herdr.state.failNextStart = true;
            const error = await source.movePlanAccount({ sessionId, provider: 'claude', folder: '/new/claude' })
                .then(() => { throw new Error('move should have failed'); })
                .catch((cause: unknown) => cause);
            expect(error).toMatchObject({ code: 'plan-move-start-failed', sessionId });
            expect(String((error as Error).message)).toContain('try again');

            const closeOfOld = herdr.calls.findIndex((call) => call.method === 'pane.close' && call.detail === 'p1');
            const firstStart = herdr.calls.findIndex((call) => call.method === 'agent.start');
            expect(closeOfOld).toBeGreaterThanOrEqual(0);
            expect(firstStart).toBeGreaterThanOrEqual(0);
            expect(closeOfOld).toBeLessThan(firstStart);

            expect(herdr.splits[0]?.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/new/claude' });
            expect(herdr.splits.at(-1)?.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/orig/claude' });

            expect(herdr.agents).toHaveLength(1);
            expect(herdr.agents[0]).toMatchObject({
                agent: 'claude',
                agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'claude-1' },
            });

            await new Promise((resolve) => setTimeout(resolve, 500));
            const reopened = await source.open({ sessionId });
            expect(reopened.info.id).toBe(sessionId);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
