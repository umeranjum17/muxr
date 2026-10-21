import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HerdrKit } from '@byokit/herdr';
import type { SessionEventBody } from '@trymuxr/contract';
import { createHerdrSessionSource } from './herdrSessionSource.js';
import { createLifecycleStore } from './lifecycleStore.js';

/**
 * pock-host-dup-emit1: a working pane's terminal title animates about twice a
 * second (`Pi 1 · 14`). Snapshots that carry only a new tick must not emit
 * session.updated; a real field change must emit exactly one.
 */
function fakeHerdr(dir: string) {
    const live = {
        terminalTitle: 'Pi 1 · 10',
        title: 'pi · Pi 1',
        agentStatus: 'idle' as 'idle' | 'working',
    };
    const statusSockets = new Set<Socket>();
    const server = createServer((socket: Socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method, params } = JSON.parse(line) as { id: string; method: string; params?: { subscriptions?: Array<{ type: string }> } };
                if (method === 'events.subscribe') {
                    if (params?.subscriptions?.some((subscription) => subscription.type === 'pane.agent_status_changed')) statusSockets.add(socket);
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
                            panes: [{
                                pane_id: 'w1:p1',
                                tab_id: 'w1:t1',
                                workspace_id: 'w1',
                                cwd: dir,
                                foreground_cwd: dir,
                                terminal_title: live.terminalTitle,
                                terminal_title_stripped: live.terminalTitle,
                                label: 'Pi 1',
                                agent_status: live.agentStatus,
                                tokens: {},
                            }],
                            agents: [{
                                pane_id: 'w1:p1',
                                tab_id: 'w1:t1',
                                workspace_id: 'w1',
                                cwd: dir,
                                foreground_cwd: dir,
                                name: 'Pi 1',
                                agent: 'pi',
                                agent_status: live.agentStatus,
                                interactive_ready: true,
                                agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'id', value: 'pi-1' },
                                title: live.title,
                                terminal_title: live.terminalTitle,
                                terminal_title_stripped: live.terminalTitle,
                                tokens: {},
                            }],
                        },
                    };
                }
                socket.end(`${JSON.stringify({ id, result })}\n`);
            }
        });
        socket.on('error', () => {});
        socket.on('close', () => statusSockets.delete(socket));
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    return { socketPath, live, close: () => server.close(), setStatus: (status: 'idle' | 'working') => {
        live.agentStatus = status;
        for (const socket of statusSockets) socket.write(`${JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: status } })}\n`);
    } };
}

describe('duplicate session.updated emit', () => {
    it('keeps title ticks quiet and applies a status push without re-cloning its tree', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-dup-emit-'));
        const herdr = fakeHerdr(dir);
        const source = await createHerdrSessionSource({
            lifecycle: createLifecycleStore(join(dir, 'lifecycle')),
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        let redundantPublishReads = 0;
        const snapshot = HerdrKit.prototype.snapshot;
        const snapshotReads = vi.spyOn(HerdrKit.prototype, 'snapshot').mockImplementation(function (this: HerdrKit) {
            const stack = new Error().stack ?? '';
            if (stack.includes('syncFromKit') && stack.includes('publish')) redundantPublishReads++;
            return snapshot.call(this);
        });
        const seen: Array<{ sessionId: string; event: SessionEventBody }> = [];
        source.subscribe((sessionId, event) => seen.push({ sessionId, event }));
        try {
            const listed = await source.list();
            expect(listed).toHaveLength(1);
            const sessionId = listed[0]!.id;
            // Drain creation + initial state; the resend path for a newly
            // connected phone replays from list(), not from these events.
            seen.length = 0;

            for (const tick of ['Pi 1 · 11', 'Pi 1 · 12', 'Pi 1 · 128']) {
                herdr.live.terminalTitle = tick;
                await source.refreshHerdr();
            }
            expect(seen.filter(({ event }) => event.type === 'session.updated')).toEqual([]);

            herdr.live.title = 'Umer duplicate emit validation';
            await source.refreshHerdr();
            const updated = seen.filter(({ event }) => event.type === 'session.updated');
            expect(updated).toHaveLength(1);
            expect(updated[0]!.sessionId).toBe(sessionId);

            // A real status push must reach the phone-facing source using the
            // tree the kit already cloned for this notification, not clone it again.
            redundantPublishReads = 0;
            herdr.setStatus('working');
            await vi.waitFor(() => expect(seen.some(({ event }) => event.type === 'status.update' && event.status.agentStatus === 'working')).toBe(true), { timeout: 10_000 });
            expect(redundantPublishReads).toBe(0);
        } finally {
            snapshotReads.mockRestore();
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
