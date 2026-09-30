import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHerdrSessionSource } from './herdrSessionSource.js';
import { planPaneAccount, rememberPlanPane } from '../../plans/planSignIn.js';
import { savePlanAccounts } from '../../plans/planStore.js';

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
    const state = { nextWait: undefined as (() => Promise<void>) | undefined, failNextStart: false, republishSession: undefined as string | undefined, failCloseFor: new Set<string>(), echoOnlyReads: 0, answerFolder: undefined as string | undefined, promptPrefixedEcho: false };
    const calls: Array<{ method: string; detail: string }> = [];
    const splits: Array<{ target: unknown; env: unknown }> = [];
    const sendTexts: Array<{ pane_id: unknown; text: unknown; live: boolean }> = [];
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
                    case 'ping':
                        reply = { id, result: { protocol: 22 } };
                        break;
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
                        const pane_id = `p${next++}`;
                        const pane = { pane_id, tab_id: 't1', workspace_id: 'w1', cwd, env: p.env, output: [] as string[] };
                        panes.push(pane);
                        splits.push({ target: p.target_pane_id, env: p.env });
                        calls.push({ method, detail: String(p.target_pane_id) });
                        reply = { id, result: { pane: { pane_id } } };
                        break;
                    }
                    case 'pane.send_text': {
                        sendTexts.push({ pane_id: p.pane_id, text: p.text, live: agents.some((agent) => agent.pane_id === p.pane_id) });
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
                        if (state.echoOnlyReads > 0) {
                            state.echoOnlyReads -= 1;
                            let text = output;
                            if (state.promptPrefixedEcho) {
                                text = output.split('\n').map((entry) => entry.startsWith('echo ') ? `$ ${entry}` : entry).join('\n');
                            }
                            reply = { id, result: { read: { text } } };
                            break;
                        }
                        const liveAgent = agents.some((agent) => agent.pane_id === p.pane_id);
                        const echo = liveAgent
                            ? undefined
                            : output.split('\n').reverse().find((entry) => entry.startsWith('echo '));
                        const parsed = /echo (\S+)=\$(\S+)/.exec(echo ?? '');
                        const evaluated = state.answerFolder
                            ?? String((pane?.env as Record<string, string> ?? {})[parsed?.[2] ?? ''] ?? '');
                        const text = parsed === null
                            ? output
                            : `${output}\n${parsed[1]}=${evaluated}\n`;
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
                        calls.push({ method, detail: String(p.target) });
                        const agent = agents.find((row) => row.pane_id === p.target);
                        const wait = state.nextWait;
                        if (wait !== undefined) {
                            state.nextWait = undefined;
                            void wait().then(
                                () => socket.end(`${JSON.stringify({ id, result: { agent } })}\n`),
                                () => socket.end(`${JSON.stringify({ id, error: { code: 'not_ready', message: 'agent not ready' } })}\n`),
                            );
                            continue;
                        }
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

describe('a plan-account move', () => {
    it('leaves the original intact after failure and starts a confirmed replacement before closing it on retry', async () => {
        const dir = mkdtempSync(join(process.cwd(), '.muxr-move-'));
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
            const original = structuredClone(herdr.agents[0]);
            const env = { MUXR_HOME: join(dir, 'muxr') };
            savePlanAccounts(env, [
                { id: 'work', provider: 'claude', name: 'Work', folder: '/orig/claude', found: false },
                { id: 'personal', provider: 'claude', name: 'Personal', folder: '/new/claude', found: false },
            ]);
            rememberPlanPane(env, 'p1', 'work', ['p1']);
            let entered!: () => void;
            const waiting = new Promise<void>((resolve) => { entered = resolve; });
            let failReady!: () => void;
            const readiness = new Promise<void>((_resolve, reject) => { failReady = () => reject(new Error('not ready')); });
            herdr.state.nextWait = () => { entered(); return readiness; };
            const moving = moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' });
            const failed = expect(moving).rejects.toMatchObject({ code: 'plan-move-start-failed' });
            await waiting;
            try {
                expect(herdr.agents).toHaveLength(2);
                const listed = await source.list();
                expect(listed.map((session) => session.paneId)).toEqual(['p1']);
                expect((await source.open({ sessionId })).info.paneId).toBe('p1');
                rememberPlanPane(env, 'other-pane', 'personal', listed.map((session) => session.paneId ?? session.id));
                expect(planPaneAccount(env, 'p1')).toEqual({ accountId: 'work' });
            } finally {
                failReady();
                await failed;
            }
            expect(planPaneAccount(env, 'p1')).toEqual({ accountId: 'work' });
            expect(herdr.agents).toEqual([original]);
            expect(herdr.panes.map((pane) => pane.pane_id)).toEqual(['p1']);
            expect(herdr.calls.some((call) => call.method === 'pane.close' && call.detail === 'p1')).toBe(false);
            expect((await source.open({ sessionId })).info.id).toBe(sessionId);

            const moved = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' });
            expect(moved.sessionId).toBe(sessionId);
            expect(herdr.agents).toHaveLength(1);
            expect(herdr.agents[0]).toMatchObject({ pane_id: 'p3', agent_session: original?.agent_session });
            const started = herdr.calls.findIndex((call) => call.method === 'agent.start' && call.detail === 'p3');
            const confirmed = herdr.calls.findIndex((call) => call.method === 'agent.wait' && call.detail === 'p3');
            const closed = herdr.calls.findIndex((call) => call.method === 'pane.close' && call.detail === 'p1');
            expect(started).toBeGreaterThanOrEqual(0);
            expect(confirmed).toBeGreaterThan(started);
            expect(closed).toBeGreaterThan(confirmed);
            expect((await source.open({ sessionId })).info.id).toBe(sessionId);

            const onNewAccount = structuredClone(herdr.agents[0]);
            herdr.state.failNextStart = true;
            await expect(moveOn(source)({ sessionId, provider: 'claude', folder: '/another/claude' }))
                .rejects.toMatchObject({ code: 'plan-move-start-failed' });
            expect(herdr.agents).toEqual([onNewAccount]);
            expect(herdr.panes.map((pane) => pane.pane_id)).toEqual(['p3']);
            expect((await source.open({ sessionId })).info.id).toBe(sessionId);
            expect(herdr.sendTexts.every((sent) => !sent.live)).toBe(true);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('returns the new session when the resume publishes as a new generation', async () => {
        const dir = mkdtempSync(join(process.cwd(), '.muxr-move-generation-'));
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

    it('refuses the new pane when the shell resolves a longer folder', async () => {
        const dir = mkdtempSync(join(process.cwd(), '.muxr-move-prefix-'));
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

            herdr.state.answerFolder = '/new/claude-backup';
            const error = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' })
                .then(() => { throw new Error('move should have refused'); })
                .catch((cause: unknown) => cause);
            expect(error).toMatchObject({ code: 'plan-move-env-mismatch' });

            expect(herdr.agents.some((agent) => agent.pane_id === 'p1')).toBe(true);
            expect(herdr.calls.some((call) => call.method === 'agent.start' && call.detail === 'p2')).toBe(false);
            expect(herdr.panes.some((pane) => pane.pane_id === 'p2')).toBe(false);

            await new Promise((resolve) => setTimeout(resolve, 500));
            expect((await source.open({ sessionId })).info.id).toBe(sessionId);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('removes the confirmed replacement when the original pane refuses to close', async () => {
        const dir = mkdtempSync(join(process.cwd(), '.muxr-move-close-'));
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

            expect(herdr.calls.filter((call) => call.method === 'agent.start')).toHaveLength(2);
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

    it('waits past the typed echo instead of refusing on the first fast poll', async () => {
        const dir = mkdtempSync(join(process.cwd(), '.muxr-move-echo-'));
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

            herdr.state.echoOnlyReads = 1;
            const moved = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' });
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect((await source.open({ sessionId: moved.sessionId })).info.id).toBe(moved.sessionId);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('waits past a prompt-prefixed echo instead of refusing on the first fast poll', async () => {
        const dir = mkdtempSync(join(process.cwd(), '.muxr-move-prompt-echo-'));
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

            herdr.state.echoOnlyReads = 1;
            herdr.state.promptPrefixedEcho = true;
            const moved = await moveOn(source)({ sessionId, provider: 'claude', folder: '/new/claude' });
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect((await source.open({ sessionId: moved.sessionId })).info.id).toBe(moved.sessionId);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
