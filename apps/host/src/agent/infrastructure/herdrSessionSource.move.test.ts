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
    const state = { failNextStart: false, failSecondSplit: false, republishSession: undefined as string | undefined, failCloseFor: new Set<string>() };
    const calls: Array<{ method: string; detail: string }> = [];
    const splits: Array<{ target: unknown; env: unknown }> = [];
    const sendTexts: Array<{ pane_id: unknown; text: unknown }> = [];
    let next = 2;
    let nextTab = 2;
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
                    case 'workspace.list':
                        reply = { id, result: { workspaces } };
                        break;
                    case 'tab.create': {
                        const tab_id = `t${nextTab++}`;
                        const pane_id = `p${next++}`;
                        const tab = { tab_id, workspace_id: p.workspace_id, label: p.label };
                        tabs.push(tab);
                        panes.push({ pane_id, tab_id, workspace_id: p.workspace_id, cwd, env: p.env, output: [] as string[] });
                        reply = { id, result: { tab: { tab_id }, root_pane: { pane_id } } };
                        break;
                    }
                    case 'pane.split': {
                        if (state.failSecondSplit && splits.length === 1) {
                            state.failSecondSplit = false;
                            reply = { id, error: { code: 'split_failed', message: 'pane.split failed' } };
                            break;
                        }
                        const pane_id = `p${next++}`;
                        const pane = { pane_id, tab_id: 't1', workspace_id: 'w1', cwd, env: p.env, output: [] as string[] };
                        panes.push(pane);
                        splits.push({ target: p.target_pane_id, env: p.env });
                        calls.push({ method, detail: String(p.target_pane_id) });
                        reply = { id, result: { pane: { pane_id } } };
                        break;
                    }
                    case 'pane.send_text': {
                        sendTexts.push({ pane_id: p.pane_id, text: p.text });
                        const pane = panes.find((row) => row.pane_id === p.pane_id);
                        if (pane !== undefined) (pane.output as string[]).push(String(p.text));
                        reply = { id, result: {} };
                        break;
                    }
                    case 'pane.read': {
                        const pane = panes.find((row) => row.pane_id === p.pane_id);
                        const output = ((pane?.output ?? []) as string[]).join('');
                        // Production only evaluates shell input on shell panes: text typed
                        // at a live agent reaches the agent as chat, never the shell.
                        const liveAgent = agents.some((agent) => agent.pane_id === p.pane_id);
                        const echo = liveAgent
                            ? undefined
                            : output.split('\n').reverse().find((entry) => entry.startsWith('echo '));
                        const parsed = /echo (\S+)=\$(\S+)/.exec(echo ?? '');
                        const text = parsed === null
                            ? output
                            : `${output}\n${parsed[1]}=${String((pane?.env as Record<string, string> ?? {})[parsed[2]!] ?? '')}\n`;
                        reply = { id, result: { read: { text } } };
                        break;
                    }
                    case 'pane.close': {
                        calls.push({ method, detail: String(p.pane_id) });
                        if (state.failCloseFor.delete(String(p.pane_id))) {
                            reply = { id, error: { code: 'close_failed', message: 'pane.close failed' } };
                            break;
                        }
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
                        const value = state.republishSession
                            ?? (resumeAt >= 0 ? String(args[resumeAt + 1]) : String(p.name));
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
        sendTexts,
        close(): void {
            server.close();
        },
    };
}

function moveOn(source: Awaited<ReturnType<typeof createHerdrSessionSource>>) {
    const move = source.movePlanAccount;
    if (!move) throw new Error('plan-account moves are not implemented');
    return move.bind(source);
}

async function launchOn(
    source: Awaited<ReturnType<typeof createHerdrSessionSource>>,
    cwd: string,
    folder: string,
): Promise<string> {
    const started = await source.start({ cwd, kind: 'claude', planEnv: { CLAUDE_CONFIG_DIR: folder } });
    if (!('info' in started)) throw new Error('launch rejected');
    return started.info.id;
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
            const sessionId = await launchOn(source, cwd, '/orig/claude');

            herdr.state.failNextStart = true;
            const error = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' })
                .then(() => { throw new Error('move should have failed'); })
                .catch((cause: unknown) => cause);
            expect(error).toMatchObject({ code: 'plan-move-start-failed', sessionId });
            expect(String((error as Error).message)).toContain('try again');

            expect(herdr.sendTexts.filter((sent) => String(sent.text).includes('MUXR_PLAN_ORIGIN_'))).toHaveLength(0);
            expect(herdr.sendTexts.filter((sent) => sent.pane_id === 'p2')).toHaveLength(0);

            const starts = herdr.calls.filter((call) => call.method === 'agent.start');
            const closeOfOld = herdr.calls.findIndex((call) => call.method === 'pane.close' && call.detail === 'p2');
            expect(closeOfOld).toBeGreaterThanOrEqual(0);
            expect(herdr.calls.indexOf(starts.at(-1)!)).toBeGreaterThan(closeOfOld);

            expect(herdr.splits[0]?.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/new/claude' });
            expect(herdr.splits.at(-1)?.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/orig/claude' });

            const rolledBack = herdr.agents.find((agent) => agent.pane_id === 'p4');
            expect(rolledBack).toMatchObject({
                agent: 'claude',
                agent_session: { source: 'herdr', agent: 'claude', kind: 'id' },
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

    it('returns the new session when the resume publishes as a new generation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-move-generation-'));
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
            const sessionId = (await source.list())[0]!.id;

            herdr.state.republishSession = 'claude-2';
            const moved = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' });
            expect(moved.sessionId).not.toBe(sessionId);
            expect(herdr.sendTexts.filter((sent) => sent.pane_id === 'p1')).toHaveLength(0);

            expect(herdr.agents).toHaveLength(1);
            expect(herdr.agents[0]).toMatchObject({
                pane_id: 'p2',
                agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'claude-2' },
            });

            await expect(source.open({ sessionId })).rejects.toMatchObject({ code: 'agent-unavailable' });
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect((await source.open({ sessionId: moved.sessionId })).info.id).toBe(moved.sessionId);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('keeps the failed pane as a shell when the rollback has nowhere to go', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-move-split-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const sessionId = await launchOn(source, cwd, '/orig/claude');

            herdr.state.failNextStart = true;
            herdr.state.failSecondSplit = true;
            const error = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' })
                .then(() => { throw new Error('move should have failed'); })
                .catch((cause: unknown) => cause);
            const shell = (error as { sessionId?: unknown }).sessionId;
            expect(error).toMatchObject({ code: 'plan-move-start-failed' });
            expect(String(shell)).toMatch(/^shell:p3$/);
            expect(String((error as Error).message)).toContain('try again');

            expect(herdr.sendTexts.filter((sent) => String(sent.text).includes('MUXR_PLAN_ORIGIN_'))).toHaveLength(0);
            expect(herdr.panes.some((pane) => pane.pane_id === 'p3')).toBe(true);
            expect(herdr.agents.some((agent) => agent.pane_id === 'p3')).toBe(false);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('aborts the move when the old pane refuses to close, starting nothing new', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-move-close-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const sessionId = await launchOn(source, cwd, '/orig/claude');

            herdr.state.failCloseFor.add('p2');
            const error = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' })
                .then(() => { throw new Error('move should have failed'); })
                .catch((cause: unknown) => cause);
            expect(error).toMatchObject({ code: 'plan-move-close-failed' });

            expect(herdr.calls.filter((call) => call.method === 'agent.start')).toHaveLength(1);
            expect(herdr.agents.some((agent) => agent.pane_id === 'p2')).toBe(true);
            expect(herdr.panes.some((pane) => pane.pane_id === 'p3')).toBe(false);

            await new Promise((resolve) => setTimeout(resolve, 500));
            expect((await source.open({ sessionId })).info.id).toBe(sessionId);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('aborts the rollback when the failed pane refuses to close, resuming nothing', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-move-rollback-close-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const sessionId = await launchOn(source, cwd, '/orig/claude');

            herdr.state.failNextStart = true;
            herdr.state.failCloseFor.add('p3');
            const error = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' })
                .then(() => { throw new Error('move should have failed'); })
                .catch((cause: unknown) => cause);
            const shell = (error as { sessionId?: unknown }).sessionId;
            expect(error).toMatchObject({ code: 'plan-move-start-failed' });
            expect(String(shell)).toMatch(/^shell:p3$/);
            expect(String((error as Error).message)).toContain('try again');

            expect(herdr.calls.some((call) => call.method === 'agent.start' && call.detail === 'p4')).toBe(false);
            expect(herdr.agents.some((agent) => agent.pane_id === 'p4')).toBe(false);
            expect(herdr.panes.some((pane) => pane.pane_id === 'p3')).toBe(true);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('keeps the failed pane as a shell when the old session has no host record', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-move-origin-'));
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
            const sessionId = (await source.list())[0]!.id;

            herdr.state.failNextStart = true;
            const error = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' })
                .then(() => { throw new Error('move should have failed'); })
                .catch((cause: unknown) => cause);
            const shell = (error as { sessionId?: unknown }).sessionId;
            expect(error).toMatchObject({ code: 'plan-move-start-failed' });
            expect(typeof shell).toBe('string');
            expect(String(shell)).toMatch(/^shell:p2$/);
            expect(String((error as Error).message)).toContain('try again');

            expect(herdr.sendTexts.filter((sent) => sent.pane_id === 'p1')).toHaveLength(0);
            expect(herdr.sendTexts.filter((sent) => String(sent.text).includes('MUXR_PLAN_ORIGIN_'))).toHaveLength(0);
            expect(herdr.agents).toHaveLength(0);
            expect(herdr.splits).toHaveLength(1);
            expect((await source.list()).map((session) => session.id)).toEqual([shell]);
            expect((await source.open({ sessionId: shell as string })).info.id).toBe(shell);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
