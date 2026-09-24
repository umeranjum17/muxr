import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHerdrSessionSource } from './herdrSessionSource.js';
import { createLifecycleStore } from './lifecycleStore.js';

/**
 * Manual rename, through the real session source against a Herdr socket that
 * keeps its own names: each kind reaches Herdr's own rename method, the tree
 * every client reads carries the new name straight after, an agent's rename is
 * not a lifecycle transition, and a name Herdr or the host refuses leaves the
 * old one standing with a plain reason.
 */
function fakeHerdr(dir: string) {
    const state = {
        workspace: 'muxr',
        tab: '1',
        paneLabel: undefined as string | undefined,
        agentName: 'alpha',
    };
    const calls: string[] = [];
    const server = createServer((socket: Socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method, params } = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
                const p = params ?? {};
                let result: unknown = {};
                let error: { code: string; message: string } | undefined;
                if (method.endsWith('.rename')) calls.push(method);
                switch (method) {
                    case 'session.snapshot':
                        result = {
                            snapshot: {
                                workspaces: [{ workspace_id: 'w1', label: state.workspace }],
                                tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: state.tab }],
                                panes: [
                                    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd: dir },
                                    { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', cwd: dir, label: state.paneLabel },
                                ],
                                agents: [{
                                    pane_id: 'w1:p1',
                                    name: state.agentName,
                                    agent: 'pi',
                                    agent_status: 'idle',
                                    agent_session: { agent: 'pi', kind: 'id', source: 'herdr:pi', value: 'rename-flow' },
                                }],
                            },
                        };
                        break;
                    case 'workspace.rename':
                        if (p.workspace_id === 'w1') state.workspace = p.label as string;
                        else error = { code: 'workspace_not_found', message: 'workspace not found' };
                        break;
                    case 'tab.rename':
                        state.tab = p.label as string;
                        break;
                    case 'pane.rename':
                        state.paneLabel = p.label as string;
                        break;
                    case 'agent.rename':
                        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(p.name as string)) {
                            error = { code: 'invalid_agent_name', message: 'agent name must start with a lowercase letter' };
                        } else if (p.name === 'bravo') {
                            error = { code: 'agent_name_taken', message: 'agent name bravo is already used; candidates: pane_id=w2:p1' };
                        } else state.agentName = p.name as string;
                        break;
                    default:
                        break;
                }
                socket.end(`${JSON.stringify(error === undefined ? { id, result } : { id, error })}\n`);
            }
        });
        socket.on('error', () => {});
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return { socketPath, calls, close: () => server.close() };
}

describe('Rename: agents, panes, tabs and workspaces are named in Herdr', () => {
    it('renames each kind, shows it in the tree at once, and refuses bad names plainly', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-rename-'));
        const herdr = fakeHerdr(dir);
        const lifecycle = createLifecycleStore(join(dir, 'lifecycle'));
        const source = await createHerdrSessionSource({
            lifecycle,
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        const tree = async () => {
            const workspace = (await source.herdrTree()).workspaces[0]!;
            const tab = workspace.tabs[0]!;
            return {
                workspace: workspace.label,
                tab: tab.label,
                agent: tab.panes.find((pane) => pane.paneId === 'w1:p1')?.agentName,
                pane: tab.panes.find((pane) => pane.paneId === 'w1:p2')?.label,
            };
        };
        try {
            await source.rename('workspace', 'w1', '  Auth   rework ');
            await source.rename('tab', 'w1:t1', 'Review');
            await source.rename('pane', 'w1:p2', 'Dev server');
            await source.rename('agent', 'w1:p1', 'auth-fixer');
            expect(herdr.calls).toEqual(['workspace.rename', 'tab.rename', 'pane.rename', 'agent.rename']);
            expect(await tree()).toEqual({ workspace: 'Auth rework', tab: 'Review', agent: 'auth-fixer', pane: 'Dev server' });
            // Still the one idle since before, now under its new name.
            expect(lifecycle.catalog().events.map((event) => [event.agentName, event.state])).toEqual([['auth-fixer', 'idle']]);

            // Refused before Herdr: nothing blank, nothing past the limit.
            await expect(source.rename('tab', 'w1:t1', '   ')).rejects.toThrow('A name cannot be empty.');
            await expect(source.rename('pane', 'w1:p2', 'x'.repeat(65))).rejects.toThrow('at most 64 characters');
            // Refused by Herdr: said plainly, and the old name stands.
            await expect(source.rename('agent', 'w1:p1', 'Auth Fixer')).rejects.toThrow(/lowercase letters, numbers, - and _/);
            await expect(source.rename('agent', 'w1:p1', 'bravo')).rejects.toThrow(/^Another agent is already called bravo\.$/);
            await expect(source.rename('workspace', 'gone', 'Elsewhere')).rejects.toThrow('That workspace is no longer available.');
            expect(herdr.calls).toHaveLength(7);
            expect(await tree()).toEqual({ workspace: 'Auth rework', tab: 'Review', agent: 'auth-fixer', pane: 'Dev server' });
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
