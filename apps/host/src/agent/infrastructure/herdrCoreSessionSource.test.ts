import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { SessionEventBody } from '@trymuxr/contract';
import type { CoreTerminal } from '../domain/herdrCoreAgents.js';
import { createHerdrCoreSessionSource } from './herdrCoreSessionSource.js';

// A Herdr Core on a real socket, speaking its JSON-RPC lines. The client and the source are the
// real ones: only the far end is scripted, so a missed notice can be sent on demand.
const terminal = (address: string, patch: Partial<CoreTerminal> = {}): CoreTerminal => ({
    address, name: `agent-${address}`, cwd: '/work', labels: { 'muxr.kind': 'pi', 'herdr.space': 'pockit', 'herdr.tab': 'fix-login' },
    state: 'live', exit_code: null, reported: true, status: { state: 'idle' }, status_ms: 2, created_ms: 1, turn: 0, ...patch,
});

function fakeCore(generation: number, terminals: CoreTerminal[]) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const dir = mkdtempSync(join(tmpdir(), 'hc-'));
    const path = join(dir, 'core.sock');
    let stream: Socket | undefined;
    const server: Server = createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += String(chunk);
            for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
                const request = JSON.parse(buffer.slice(0, end)) as { id: number; method: string; params: Record<string, unknown> };
                calls.push({ method: request.method, params: request.params });
                buffer = buffer.slice(end + 1);
                const results: Record<string, unknown> = {
                    hello: { generation, version: '9.9.9' },
                    'events.subscribe': { seq: 5, terminals },
                    'terminal.list': { terminals },
                    'terminal.run': terminal('t9', { labels: request.params.labels as Record<string, string>, cwd: String(request.params.cwd), reported: false, status: null }),
                    'terminal.get': terminal('t9', { state: 'finished', exit_code: 0 }),
                };
                const result = results[request.method] ?? {};
                if (request.method === 'events.subscribe') stream = socket;
                socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
            }
        });
    });
    return {
        path,
        calls,
        listen: () => new Promise<void>((resolve) => server.listen(path, resolve)),
        push: (type: string, event: Record<string, unknown>) => stream?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, ...event } })}\n`),
        stop: () => { server.close(); rmSync(dir, { recursive: true, force: true }); },
    };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };

test('Home reads agents, status and spaces from Herdr Core, resyncs after missed, and refuses a newer core', async () => {
    // A core that speaks a newer protocol is refused with what to do about it.
    const newer = fakeCore(2, []);
    cleanups.push(newer.stop);
    await newer.listen();
    await expect(createHerdrCoreSessionSource({ socketPath: newer.path })).rejects.toThrow(/generation 2.*Update muxr/);

    const core = fakeCore(1, [
        terminal('t1', { status: { state: 'working' } }),
        terminal('t2', { reported: false, status: null }),
        terminal('t3', { labels: {} }),
    ]);
    cleanups.push(core.stop);
    await core.listen();
    const source = await createHerdrCoreSessionSource({ socketPath: core.path });
    cleanups.push(() => source.close());
    const events: Array<[string, SessionEventBody]> = [];
    source.subscribe((id, event) => events.push([id, event]));

    // Agents are the labelled terminals; a silent one is Starting, never Working or Done.
    expect((await source.list()).map((s) => [s.id, s.agentStatus])).toEqual([['hc_t1', 'working'], ['hc_t2', 'starting']]);
    const tree = await source.herdrTree();
    expect(tree.connected).toBe(true);
    expect(tree.workspaces.map((w) => [w.label, w.tabs.map((t) => t.label), w.agentStatus])).toEqual([['pockit', ['fix-login'], 'working']]);

    // The program's own word, pushed: Done reaches the subscriber and the next read.
    core.push('status', { seq: 6, terminal: 't1', data: { reported: true, status: { state: 'done' } } });
    await until(() => events.some(([, e]) => e.type === 'status.update'));
    expect(events.find(([, e]) => e.type === 'status.update')?.[1]).toMatchObject({ status: { sessionId: 'hc_t1', agentStatus: 'done' } });
    expect((await source.status('hc_t1')).agentStatus).toBe('done');

    // Missed events: the fresh snapshot replaces what the source held. t1 is gone, t4 is new.
    events.length = 0;
    core.push('missed', { seq: 9, terminal: undefined, data: { seq: 9, terminals: [terminal('t4', { status: { state: 'working' } })] } });
    await until(() => events.some(([, e]) => e.type === 'session.removed'));
    expect(events.map(([id, e]) => `${id} ${e.type}`).sort()).toEqual(['hc_t1 session.removed', 'hc_t2 session.removed', 'hc_t4 session.created']);
    expect((await source.list()).map((s) => s.id)).toEqual(['hc_t4']);
});

test('the phone starts, prompts and stops an agent through Core, which holds its space and tab', async () => {
    const core = fakeCore(1, []);
    cleanups.push(core.stop);
    await core.listen();
    const source = await createHerdrCoreSessionSource({ socketPath: core.path, agentCommands: { pi: ['/lab/pi'] } });
    cleanups.push(() => source.close());
    const events: string[] = [];
    source.subscribe((id, event) => events.push(`${id} ${event.type}`));

    expect(await source.installedAgentKinds(['pi', 'claude'])).toEqual(['pi']);
    await expect(source.start({ cwd: '/work/pockit', kind: 'claude' })).rejects.toThrow(/no way to start claude/);
    const started = await source.start({ cwd: '/work/pockit', kind: 'pi', label: 'Fix login' });
    expect(started).toMatchObject({ info: { id: 'hc_t9', workspaceLabel: 'pockit', tabLabel: 'fix-login', agentStatus: 'starting' } });
    expect(core.calls.find((call) => call.method === 'terminal.run')?.params).toMatchObject({ argv: ['/lab/pi'], labels: { 'muxr.kind': 'pi', 'herdr.space': 'pockit', 'herdr.tab': 'fix-login' } });

    await source.prompt({ sessionId: 'hc_t9', text: 'fix the login bug' });
    expect(core.calls.find((call) => call.method === 'terminal.send')?.params).toMatchObject({ terminal: 't9', text: 'fix the login bug' });

    expect(await source.stop('hc_t9', {})).toEqual({ status: 'closed' });
    expect(core.calls.map((call) => call.method).filter((method) => method.startsWith('terminal.') && method !== 'terminal.list')).toEqual(['terminal.run', 'terminal.send', 'terminal.kill', 'terminal.get', 'terminal.rm']);
    expect(events).toEqual(['hc_t9 session.created', 'hc_t9 session.removed']);
    expect(await source.list()).toEqual([]);
});
