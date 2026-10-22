import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentTask } from '@trymuxr/contract';
import { createHerdrSessionSource } from './herdrSessionSource.js';
import { createLifecycleStore } from './lifecycleStore.js';

/**
 * After a restart Claude titles every lead pane with its first chat topic
 * from a Firstmate doorbell (`Firstmate operational inbox message`). That
 * title names nothing. The Herdr tab label names the pane, in words, even when
 * the launcher gave the agent the same name.
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
    const panes = [
        pane('1', 'w2:t1'),
        { ...pane('2', 'w2:t2'), label: 'Review the crewhouse office' },
        // The reported row: an unlabelled tab, Claude's doorbell title, agent `firstmate-addons`.
        { ...pane('3', 'w2:t3'), terminal_title: '✳ Firstmate operational inbox input', terminal_title_stripped: 'Firstmate operational inbox input' },
    ];
    const workspace = { workspace_id: 'w2', label: 'firstmate' };
    const tabs = [
        { tab_id: 'w2:t1', workspace_id: 'w2', label: 'fd-prompt-nosript' },
        { tab_id: 'w2:t2', workspace_id: 'w2', label: 'fm-crewhouse' },
        // Herdr's default numbered tab names nothing.
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
                                name: ['fd-prompt-nosript', 'fm-crewhouse', 'firstmate-addons'][index],
                                // The task-titles plugin's title leads over the tab label.
                                ...(index === 1 ? { title: 'Show the SSH key fingerprint' } : {}),
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
    it('names lead panes by their tab label after a restart, and the workspace by its Herdr label', async () => {
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
            // No doorbell title is a task: the unlabelled pane has none, so the phone names it by its agent.
            expect(listed.map((info) => info.taskTitle ?? '(none)').sort()).toEqual(['(none)', 'Fd prompt nosript', 'Show the SSH key fingerprint']);
            expect(listed.every((info) => info.workspaceLabel === 'firstmate')).toBe(true);

            const { workspaces } = await source.herdrTree();
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
            expect(shown).toEqual(['Fd prompt nosript', 'Show the SSH key fingerprint', undefined]);

            // A relabel without a push still reaches later lists through the
            // coalesced background discovery: no first-seen name sticks.
            herdr.tabs[0]!.label = 'fd-renamed';
            herdr.workspace.label = 'muxr';
            await vi.waitFor(async () => {
                const relisted = await source.list();
                expect(relisted.map((info) => info.taskTitle ?? '(none)').sort()).toEqual(['(none)', 'Fd renamed', 'Show the SSH key fingerprint']);
                expect(relisted.every((info) => info.workspaceLabel === 'muxr')).toBe(true);
            }, { timeout: 10_000 });
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
