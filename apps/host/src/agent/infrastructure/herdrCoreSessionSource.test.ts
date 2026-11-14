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

function fakeCore(generation: number, terminals: CoreTerminal[], seed?: unknown) {
    // The one document Core keeps, with its version; `outbid` makes the next write lose to another writer.
    const doc = { value: (seed ?? null) as unknown, version: seed === undefined ? 0 : 1, outbid: false };
    let runs = 0;
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
                if (request.method === 'doc.set') {
                    const conflict = doc.outbid || request.params.version !== doc.version;
                    doc.outbid = false;
                    if (conflict) { doc.version += 1; socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'conflict', data: { kind: 'conflict' } } })}\n`); continue; }
                    doc.value = request.params.value;
                    doc.version += 1;
                }
                const results: Record<string, unknown> = {
                    'doc.get': { value: doc.value, version: doc.version },
                    'doc.set': { version: doc.version },
                    hello: { generation, version: '9.9.9' },
                    'events.subscribe': { seq: 5, terminals },
                    'terminal.list': { terminals },
                    'terminal.run': terminal(`t${String(request.method === 'terminal.run' ? 9 + runs++ : 9)}`, { labels: request.params.labels as Record<string, string>, cwd: String(request.params.cwd), reported: false, status: null }),
                    'terminal.get': terminal(String(request.params.terminal), { state: 'finished', exit_code: 0 }),
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
        doc,
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

test('Home groups agents by the Herdr app layout, keeps what the layout holds that muxr does not know, and falls back to labels', async () => {
    const block = (id: string, terminal: string) => ({ id, type: 'block', content: { terminal } });
    // The Herdr app's own document: a space and tab renamed from the labels, with fields muxr has never heard of.
    const seed = { future: { a: 1 }, spaces: [{ id: 'sp1', name: 'Pockit', folder: '/work', pinned: true, tabs: [
        { id: 'tb1', name: 'Fixes', accent: 'green', root: { id: 'r1', type: 'row', gap: 4, children: [block('b1', 't1'), block('b2', 't2')] } },
    ] }] };
    const core = fakeCore(1, [terminal('t1'), terminal('t2', { labels: { 'muxr.kind': 'pi', 'herdr.space': 'pockit', 'herdr.tab': 'review' } })], seed);
    cleanups.push(core.stop);
    await core.listen();
    const source = await createHerdrCoreSessionSource({ socketPath: core.path, agentCommands: { pi: ['/lab/pi'] } });
    cleanups.push(() => source.close());
    const events: string[] = [];
    source.subscribe((id, event) => events.push(`${id} ${event.type}`));
    const shape = async () => (await source.herdrTree()).workspaces.map((w) => [w.label, w.tabs.map((t) => [t.label, t.panes.map((p) => p.paneId)])]);

    // The document wins over the labels: both agents are panes of its one tab.
    expect(await shape()).toEqual([['Pockit', [['Fixes', ['t1', 't2']]]]]);
    expect((await source.list()).map((s) => [s.id, s.workspaceLabel, s.tabLabel])).toEqual([['hc_t1', 'Pockit', 'Fixes'], ['hc_t2', 'Pockit', 'Fixes']]);

    // Rename a tab: the write loses once to the Herdr app, then lands; clients hear it; unknown fields survive.
    core.doc.outbid = true;
    await source.rename('tab', 'tb1', ' Ship it ');
    expect((await source.list()).map((s) => s.tabLabel)).toEqual(['Ship it', 'Ship it']);
    expect(events).toContain('hc_t1 session.updated');
    expect(core.doc.value).toMatchObject({ future: { a: 1 }, spaces: [{ id: 'sp1', pinned: true, tabs: [{ name: 'Ship it', accent: 'green', root: { gap: 4 } }] }] });
    await source.rename('workspace', 'sp1', 'pockit-app');

    // New tab: a second tab in the same space, running the anchor's kind. Split: a column inside the row.
    const tab = await source.createTab('hc_t1', { label: 'Review' });
    expect(tab.sessionId).toBe('hc_t9');
    const split = await source.paneSplit({ sessionId: 'hc_t1', direction: 'down', kind: 'pi' });
    expect(split).toEqual({ paneId: 't10', sessionId: 'hc_t10' });
    await expect(source.paneSplit({ sessionId: 'hc_t1', direction: 'down' })).rejects.toThrow(/without an agent/);
    expect(await shape()).toEqual([['pockit-app', [['Ship it', ['t1', 't10', 't2']], ['Review', ['t9']]]]]);
    const tabs = (core.doc.value as { spaces: Array<{ tabs: Array<{ root: { children: Array<{ type: string; children?: unknown[] }> } }> }> }).spaces[0]?.tabs;
    expect(tabs?.[0]?.root.children.map((child) => child.type)).toEqual(['column', 'block']);
    expect(core.calls.find((call) => call.method === 'terminal.run')?.params).toMatchObject({ labels: { 'herdr.space': 'pockit-app', 'herdr.tab': 'Review' } });

    // Close: a tab ends its agents and leaves the document without it; closing the last tab drops the space.
    await source.closeTab('hc_t1', (await source.herdrTree()).workspaces[0]?.tabs[1]?.tabId ?? '');
    expect(await shape()).toEqual([['pockit-app', [['Ship it', ['t1', 't10', 't2']]]]]);
    await source.closeWorkspace((await source.herdrTree()).workspaces[0]?.workspaceId ?? '');
    expect(await shape()).toEqual([]);
    expect(core.doc.value).toMatchObject({ future: { a: 1 }, spaces: [] });

    // A layout muxr cannot read is never written over: agents are still listed by their labels,
    // starting still works, and a rename says why it cannot happen.
    const broken = fakeCore(1, [terminal('t1')], { spaces: 'not a list' });
    cleanups.push(broken.stop);
    await broken.listen();
    const problems: string[] = [];
    const fallback = await createHerdrCoreSessionSource({ socketPath: broken.path, agentCommands: { pi: ['/lab/pi'] }, onProblem: (message) => problems.push(message) });
    cleanups.push(() => fallback.close());
    expect((await fallback.herdrTree()).workspaces.map((w) => [w.label, w.tabs.map((t) => t.label)])).toEqual([['pockit', ['fix-login']]]);
    await expect(fallback.rename('tab', 'tab:pockit/fix-login', 'x')).rejects.toThrow(/cannot be read/);
    await fallback.start({ cwd: '/work/other', kind: 'pi' });
    expect((await fallback.list()).map((s) => s.workspaceLabel)).toEqual(['pockit', 'other']);
    expect(broken.doc.value).toEqual({ spaces: 'not a list' });
    expect(problems.some((message) => /cannot be read/.test(message))).toBe(true);
});
