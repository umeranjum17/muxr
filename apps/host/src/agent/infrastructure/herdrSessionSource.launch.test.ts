import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HerdrTreeWorkspace } from '@muxr/contract';
import { createHerdrSessionSource, boundedWorkspaceTokens, MUXR_AGENT_ENV } from './herdrSessionSource.js';

/**
 * The slice of herdr a phone launch touches. `agent.start` answers the way
 * herdr 0.8 does: the record carries the launch name but no kind or session
 * until the process is detected, which is the boot window under test.
 */
function fakeHerdr(dir: string, cwd: string) {
    const workspaces = [{ workspace_id: 'w1', label: cwd }];
    const tabs: Record<string, unknown>[] = [];
    const panes: Record<string, unknown>[] = [];
    const agents: Record<string, unknown>[] = [];
    const subscribers = new Set<Socket>();
    let next = 1;
    const handleSnapshot = () => ({ snapshot: { workspaces, tabs, panes, agents } });
    const handlePluginList = () => ({ plugins: [] });
    const handleWorkspaceList = () => ({ workspaces });
    const handleTabCreate = (params: Record<string, unknown>) => {
        const tab_id = `t${next}`;
        const pane_id = `w1:p${next++}`;
        tabs.push({ tab_id, workspace_id: 'w1', label: params.label ?? cwd, env: params.env });
        panes.push({ pane_id, tab_id, workspace_id: 'w1', cwd });
        return { tab: { tab_id }, root_pane: { pane_id } };
    };
    const handleAgentStart = (params: Record<string, unknown>) => {
        const agent = { pane_id: params.pane_id, name: params.name, agent_status: 'idle' };
        agents.push(agent);
        return { agent };
    };
    const handleAgentWait = (params: Record<string, unknown>) => ({
        agent: agents.find((agent) => agent.pane_id === params.target),
    });
    const handlePaneClose = () => ({});
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
                    subscribers.add(socket);
                    continue;
                }
                const p = params ?? {};
                let reply: unknown;
                switch (method) {
                    case 'session.snapshot':
                        reply = { id, result: handleSnapshot() };
                        break;
                    case 'plugin.list':
                        reply = { id, result: handlePluginList() };
                        break;
                    case 'workspace.list':
                        reply = { id, result: handleWorkspaceList() };
                        break;
                    case 'tab.create':
                        reply = { id, result: handleTabCreate(p) };
                        break;
                    case 'agent.start':
                        reply = { id, result: handleAgentStart(p) };
                        break;
                    case 'agent.wait':
                        reply = { id, result: handleAgentWait(p) };
                        break;
                    case 'pane.close':
                        reply = { id, result: handlePaneClose() };
                        break;
                    default:
                        reply = { id, error: { code: 'method_not_found', message: method } };
                        break;
                }
                socket.end(`${JSON.stringify(reply)}\n`);
            }
        });
        socket.on('error', () => {});
        socket.on('close', () => subscribers.delete(socket));
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return {
        socketPath,
        agents,
        tabs,
        emit(type: string, data: Record<string, unknown>): void {
            for (const socket of subscribers) socket.write(`${JSON.stringify({ event: type, data })}\n`);
        },
        close(): void {
            for (const socket of subscribers) socket.destroy();
            server.close();
        },
    };
}

function treePane(tree: { workspaces: HerdrTreeWorkspace[] }, paneId: string) {
    const pane = tree.workspaces.flatMap((ws) => ws.tabs).flatMap((tab) => tab.panes).find((row) => row.paneId === paneId);
    if (pane === undefined) throw new Error(`pane ${paneId} missing from herdr.tree`);
    return pane;
}

describe('phone launch before herdr detects the agent', () => {
    it('keeps the requested kind through the boot window and drops it once the launch gives up', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-launch-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            attachmentsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        const removedSessions: string[] = [];
        const unsubscribe = source.subscribe((sessionId, event) => {
            if (event.type === 'session.removed') removedSessions.push(sessionId);
        });
        try {
            const started = await source.start({ cwd, kind: 'claude' });
            if (!('info' in started)) throw new Error('launch rejected');
            const sessionId = started.info.id;

            // Herdr's own snapshot has replaced the seeded record: launch name, no kind yet.
            await source.refreshHerdr();
            expect(herdr.agents[0]).toEqual({ pane_id: 'w1:p1', name: expect.stringMatching(/^pp_/), agent_status: 'idle' });
            expect(herdr.tabs[0]).toMatchObject({ env: MUXR_AGENT_ENV });
            let pane = treePane(await source.herdrTree(), 'w1:p1');
            expect(pane).toMatchObject({ agentKind: 'claude', sessionId });
            expect(pane.agentName).toBeUndefined();

            // Detection: herdr publishes the kind and its own session; the route survives adoption.
            Object.assign(herdr.agents[0]!, {
                agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'claude-1' },
            });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1' });
            await source.refreshHerdr();
            pane = treePane(await source.herdrTree(), 'w1:p1');
            expect(pane).toMatchObject({ agentKind: 'claude', sessionId });

            // A launch herdr never detects: the stand-in kind expires with the launch window,
            // and a later refresh (which rehydrates the pending launch from its route) cannot revive it.
            const failed = await source.start({ cwd, kind: 'codex' });
            if (!('info' in failed)) throw new Error('launch rejected');
            await source.refreshHerdr();
            expect(treePane(await source.herdrTree(), 'w1:p2').agentKind).toBe('codex');
            const now = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => now + 300_000);
            expect(treePane(await source.herdrTree(), 'w1:p2').agentKind).toBeUndefined();
            await source.refreshHerdr();
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(removedSessions).toContain(failed.info.id);
            expect(treePane(await source.herdrTree(), 'w1:p2').agentKind).toBeUndefined();
            expect(treePane(await source.herdrTree(), 'w1:p1').agentKind).toBe('claude');
        } finally {
            unsubscribe();
            vi.restoreAllMocks();
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

// Producer tokens cross from Herdr plugins to the phone, so the bound is a trust boundary.
it('bounds workspace tokens: known keys only, capped count, sanitized capped values', () => {
    expect(boundedWorkspaceTokens({ parent: 'w1R4', kind: 'task', projection: '8NwSBmQ5YerlAcFOBfSrqg' }))
        .toEqual({ parent: 'w1R4', kind: 'task', projection: '8NwSBmQ5YerlAcFOBfSrqg' });
    expect(boundedWorkspaceTokens({ Bad: 'x', '9lead': 'x', Upper: 'x', ok_key: 'kept' })).toEqual({ ok_key: 'kept' });
    expect(boundedWorkspaceTokens(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v']))))
        .toHaveProperty('k7');
    expect(Object.keys(boundedWorkspaceTokens(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v'])))!)).toHaveLength(8);
    const long = boundedWorkspaceTokens({ parent: 'w'.repeat(200) })!;
    expect(long.parent!.length).toBeLessThanOrEqual(64);
    expect(boundedWorkspaceTokens({ parent: 'a\u000Bb\uFEFFc' })).toEqual({ parent: 'abc' });
    expect(boundedWorkspaceTokens(undefined)).toBeUndefined();
    expect(boundedWorkspaceTokens(['not', 'an', 'object'])).toBeUndefined();
});
