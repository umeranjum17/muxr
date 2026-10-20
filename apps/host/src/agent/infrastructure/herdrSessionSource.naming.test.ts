import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentTask } from '@trymuxr/contract';
import { createHerdrSessionSource } from './herdrSessionSource.js';
import { createLifecycleStore } from './lifecycleStore.js';

/**
 * After a restart Claude titles every lead pane with its first chat topic
 * (`Firstmate operational inbox message`). The Herdr tab label names the pane
 * as Herdr's sidebar does, even when the launcher gave the agent the same
 * name, and a workspace labelled with an SSH key's type word is unnamed.
 */
function fakeHerdr(dir: string) {
    const pane = (n: string, tab: string) => ({
        pane_id: `w2:p${n}`,
        tab_id: tab,
        workspace_id: 'w2',
        cwd: join(dir, 'firstmate'),
        foreground_cwd: join(dir, 'firstmate'),
        terminal_title: '✳ Firstmate operational inbox message',
        terminal_title_stripped: 'Firstmate operational inbox message',
        agent_status: 'idle',
        tokens: {},
    });
    // A pane's own self-name gives way to its tab label.
    const panes = [pane('1', 'w2:t1'), { ...pane('2', 'w2:t2'), label: 'Review the crewhouse office' }, pane('3', 'w2:t3')];
    const workspace = { workspace_id: 'w2', label: 'ssh-ed25519' };
    const tabs = [
        { tab_id: 'w2:t1', workspace_id: 'w2', label: 'fd-prompt-nosript' },
        { tab_id: 'w2:t2', workspace_id: 'w2', label: 'fm-crewhouse' },
        // Herdr's default numbered tab names nothing: the title stands.
        { tab_id: 'w2:t3', workspace_id: 'w2', label: '12' },
    ];
    const server = createServer((socket: Socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method } = JSON.parse(line) as { id: string; method: string };
                if (method === 'events.subscribe') {
                    socket.write(`${JSON.stringify({ id, result: {} })}\n`);
                    continue;
                }
                let result: unknown = {};
                if (method === 'ping') result = { protocol: 22 };
                if (method === 'session.snapshot') {
                    result = {
                        snapshot: {
                            workspaces: [workspace],
                            tabs,
                            panes,
                            agents: panes.map((entry, index) => ({
                                ...entry,
                                // A launcher names the agent after its tab.
                                name: ['fd-prompt-nosript', 'fm-crewhouse', 'lead-3'][index],
                                // Every agent kind names the same way.
                                agent: index === 1 ? 'codex' : 'claude',
                                interactive_ready: true,
                                agent_session: { source: `herdr:${index === 1 ? 'codex' : 'claude'}`, agent: index === 1 ? 'codex' : 'claude', kind: 'id', value: `agent-${index + 1}` },
                            })),
                        },
                    };
                }
                socket.end(`${JSON.stringify({ id, result })}\n`);
            }
        });
        socket.on('error', () => {});
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return { socketPath, workspace, tabs, close: () => server.close() };
}

describe('pane and workspace names', () => {
    it('names lead panes by their tab label after a restart, and never shows a key type as a workspace', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-pane-names-'));
        const herdr = fakeHerdr(dir);
        const source = await createHerdrSessionSource({
            lifecycle: createLifecycleStore(join(dir, 'lifecycle')),
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const listed = await source.list();
            expect(listed.map((info) => info.taskTitle).sort()).toEqual(['Firstmate operational inbox message', 'fd-prompt-nosript', 'fm-crewhouse']);
            expect(listed.every((info) => info.workspaceLabel === undefined)).toBe(true);

            const { workspaces } = await source.herdrTree();
            expect(workspaces[0]).not.toHaveProperty('label');
            // The phone re-derives the name from the tree pane by the same rule.
            const shown = workspaces[0]!.tabs.flatMap((tab) => tab.panes).map((pane) => agentTask({
                label: pane.label,
                tabLabel: pane.tabLabel,
                terminalTitle: pane.terminalTitle,
                title: pane.taskTitle,
                agentName: pane.agentName,
                agentKind: pane.agentKind,
                cwd: pane.cwd,
            }));
            expect(shown).toEqual(['fd-prompt-nosript', 'fm-crewhouse', 'Firstmate operational inbox message']);

            // A relabel in Herdr renames the pane and the workspace on the next read: no first-seen name sticks.
            herdr.tabs[0]!.label = 'fd-renamed';
            herdr.workspace.label = 'muxr';
            const relisted = await source.list();
            expect(relisted.map((info) => info.taskTitle).sort()).toEqual(['Firstmate operational inbox message', 'fd-renamed', 'fm-crewhouse']);
            expect(relisted.every((info) => info.workspaceLabel === 'muxr')).toBe(true);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
