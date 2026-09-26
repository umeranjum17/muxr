import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type { HerdrTreeWorkspace } from '@muxr/contract';

const mocks = vi.hoisted(() => ({
    focused: true,
    request: vi.fn(),
    replace: vi.fn(),
    catalog: { workspaces: [] as HerdrTreeWorkspace[], loaded: true },
    catalogListeners: new Set<() => void>(),
    terminalMounts: [] as string[],
    terminalChannels: new Map<string, { sendText: (text: string) => void }>(),
    fetch: vi.fn(),
    settings: { relayUrl: 'ws://relay.test', machineId: 'machine', token: 'devtok_test' },
}));

vi.mock('@/connection', () => ({
    channelRelayUrl: async (relayUrl: string) => relayUrl,
    getCachedConnectionSettings: () => mocks.settings,
}));

vi.mock('@/catalog/sync', () => ({
    sync: { request: mocks.request, currentMachineId: () => mocks.settings.machineId, openTerminalLink: () => undefined, hasTerminalLink: () => false },
}));

vi.mock('@/pairing/e2ee', () => ({
    getCachedHostedGrant: () => undefined,
    DeviceV2Crypto: class {},
}));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => mocks.focused }));
vi.mock('expo-router', () => ({ router: { replace: mocks.replace } }));
vi.mock('@/catalog/store', async () => {
    const React = await import('react');
    const { create } = await import('zustand');
    // The machine transport's word on the host, as sync.ts records it.
    const storage = create<{ socketStatus: string; setSocketStatus: (socketStatus: string) => void }>()((set) => ({
        socketStatus: 'connected',
        setSocketStatus: (socketStatus) => set({ socketStatus }),
    }));
    return { storage, useHerdrTree: () => React.useSyncExternalStore(
        (listener) => { mocks.catalogListeners.add(listener); return () => { mocks.catalogListeners.delete(listener); }; },
        () => mocks.catalog,
    ), useLifecycleEvents: () => [] };
});
vi.mock('@/herd', () => ({
    useActivityAcknowledgements: () => ({ ready: false, seenEventIds: new Set<string>(), markSeen: () => {} }),
}));
vi.mock('@/watch/lifecycleAlert', () => ({ agentOnScreen: () => () => undefined }));
vi.mock('../presentation/TerminalScreen', async () => {
    const React = await import('react');
    const { openTerminal } = await import('./OpenTerminal');
    return { TerminalScreen: ({ id }: { id: string }) => {
        React.useEffect(() => {
            mocks.terminalMounts.push(id);
            let disposed = false;
            let channel: Awaited<ReturnType<typeof openTerminal>> | undefined;
            void openTerminal({ agentRoute: id, size: { cols: 80, rows: 24 } }).then((opened) => {
                if (disposed) { opened.close(); return; }
                channel = opened;
                mocks.terminalChannels.set(id, opened);
            });
            return () => { disposed = true; channel?.close(); mocks.terminalChannels.delete(id); };
        }, [id]);
        return React.createElement('terminal-screen', { id });
    } };
});

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    readonly send = vi.fn();

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    drop(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }

    readonly close = vi.fn((): void => {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.drop();
    });
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('fetch', mocks.fetch);

import { encodeBase64 } from '@/encryption/base64';
import { openTerminal } from './OpenTerminal';
import { TerminalRoute } from '../presentation/TerminalRoute';
import { createTerminalWritePump } from './terminalWritePump';
import { formatConnectionDiagnosticsForReport, readConnectionDiagnostics, resetConnectionDiagnostics } from '@/catalog/infrastructure/connectionDiagnostics';

describe('openTerminal reconnect ownership', () => {
    beforeEach(() => {
        mocks.request.mockReset();
        mocks.replace.mockReset();
        mocks.catalog = { workspaces: [], loaded: true };
        mocks.terminalMounts.length = 0;
        mocks.terminalChannels.clear();
        mocks.fetch.mockReset();
        mocks.settings.token = 'devtok_test';
        mocks.fetch.mockResolvedValue({
            ok: true,
            status: 201,
            json: async () => ({ ticket: 'pwt-test', expires_in: 60 }),
        });
        FakeWebSocket.instances.length = 0;
        resetConnectionDiagnostics();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fails closed before attach when an account token cannot mint a ticket', async () => {
        mocks.settings.token = 'acctok_stale';
        await expect(openTerminal({ agentRoute: 'session', size: { cols: 100, rows: 30 } }))
            .rejects.toThrow('terminal: relay ticket required');
        expect(mocks.request).not.toHaveBeenCalled();
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(readConnectionDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({ event: 'terminal.channel', phase: 'attach', code: 'ticket-required' }),
        ]));
    });

    it('replays the first paint when it arrives before the native view subscribes', async () => {
        mocks.request.mockResolvedValue({});
        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        const socket = FakeWebSocket.instances[0]!;
        socket.open();
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'full-paint' }) });

        const frames: string[] = [];
        channel.onData((bytes) => frames.push(bytes));
        expect(frames).toEqual(['full-paint']);

        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'ansi' }) });
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'plain-herdr' }) });
        expect(frames).toEqual(['full-paint', 'ansi', 'plain-herdr']);

        channel.repaint();
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
        expect(mocks.request).toHaveBeenLastCalledWith('terminal.attach', expect.objectContaining({
            sessionId: 'session', channel: expect.any(String), cols: 100, rows: 30,
        }));

        channel.close();
    });

    it('connects a new pane whose grid settles mid-attach without ever reading as reconnecting', async () => {
        // The host is slow to attach; the ticket for the pane's socket is
        // already on its way meanwhile, not one round trip after.
        const firstAttach = Promise.withResolvers<unknown>();
        mocks.request.mockReturnValueOnce(firstAttach.promise).mockResolvedValue({});
        const opening = openTerminal({ agentRoute: 'shell:new-pane', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
        firstAttach.resolve({});
        const channel = await opening;
        const states: string[] = [];
        channel.onState((state) => states.push(state));

        // The pane's chrome filled in before its first frame: the grid it
        // attached at is gone, so it attaches again at the settled one.
        channel.resize(100, 29);
        channel.repaint();
        await vi.waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith('terminal.attach', expect.objectContaining({
            sessionId: 'shell:new-pane', cols: 100, rows: 29,
        })));
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
        const socket = FakeWebSocket.instances[1]!;
        socket.open();
        expect(states).toEqual(['connecting']);
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'prompt' }) });
        await vi.waitFor(() => expect(states).toEqual(['connecting', 'live']));

        // Once it has painted, a re-attach is a reconnect.
        channel.repaint();
        expect(states.at(-1)).toBe('reconnecting');
        channel.close();
    });

    it('drives socket frames through one in-flight write pump with a bounded backlog', async () => {
        mocks.request.mockResolvedValue({});
        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        const socket = FakeWebSocket.instances[0]!;
        socket.open();

        const writes: string[] = [];
        const readyWrites: boolean[] = [];
        let concurrent = 0;
        let maxConcurrent = 0;
        const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
        const recoveries: unknown[] = [];
        let scheduledId = 0;
        const scheduled = new Set<number>();
        const pump = createTerminalWritePump({
            write: (bytes, ready) => {
                readyWrites.push(ready);
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                writes.push(bytes);
                return new Promise<void>((resolve, reject) => {
                    gates.push({
                        resolve: () => { concurrent -= 1; resolve(); },
                        reject: (error) => { concurrent -= 1; reject(error); },
                    });
                });
            },
            combineText: (frames) => frames.join(''),
            schedule: (run) => {
                const handle = ++scheduledId;
                scheduled.add(handle);
                queueMicrotask(() => {
                    if (!scheduled.has(handle)) return;
                    scheduled.delete(handle);
                    run();
                });
                return handle;
            },
            cancelSchedule: (handle) => { scheduled.delete(handle as number); },
            onRejected: (error) => { recoveries.push(error); },
        });
        channel.onData((bytes) => {
            pump.push({ bytes, ready: bytes === 'text-C' });
        });

        const frame = (bytes: string) => {
            socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes }) });
        };

        // Single-flight: a stalled native write holds every later frame back,
        // and adjacent text coalesces into one native write.
        frame('text-A');
        await vi.waitFor(() => expect(writes).toEqual(['text-A']));
        frame('text-B');
        frame('text-C');
        expect(writes).toEqual(['text-A']);
        expect(maxConcurrent).toBe(1);
        gates[0]!.resolve();
        await vi.waitFor(() => expect(writes).toEqual(['text-A', 'text-Btext-C']));
        expect(readyWrites).toEqual([false, true]);
        expect(maxConcurrent).toBe(1);
        gates[1]!.resolve();
        await vi.waitFor(() => expect(concurrent).toBe(0));

        // Cancel drops queued frames but lets the admitted write settle.
        frame('text-D');
        await vi.waitFor(() => expect(writes.at(-1)).toBe('text-D'));
        frame('text-E');
        const cancelled = pump.cancel();
        gates[2]!.resolve();
        await cancelled;
        await Promise.resolve();
        expect(writes.at(-1)).toBe('text-D');
        expect(writes).not.toContain('text-E');

        // A failed write rejects once and drops the backlog, so recovery is a
        // fresh repaint rather than a replay of stale cells.
        frame('text-F');
        await vi.waitFor(() => expect(writes.at(-1)).toBe('text-F'));
        frame('text-G');
        gates[3]!.reject(undefined);
        await vi.waitFor(() => expect(recoveries).toEqual([undefined]));
        expect(writes).not.toContain('text-G');
        expect(maxConcurrent).toBe(1);

        // A stalled native writer cannot accumulate unlimited frames. Recover
        // only after its admitted write settles, never overlap a new surface.
        frame('blocked-write');
        await vi.waitFor(() => expect(writes.at(-1)).toBe('blocked-write'));
        for (let i = 0; i < 129; i++) frame(`queued-${i}`);
        expect(recoveries).toHaveLength(1);
        gates[4]!.resolve();
        await vi.waitFor(() => expect(recoveries).toHaveLength(2));
        expect(String(recoveries[1])).toContain('backlog exceeded');
        expect(writes.some((entry) => entry.startsWith('queued-'))).toBe(false);
        frame('recovered-paint');
        await vi.waitFor(() => expect(writes.at(-1)).toBe('recovered-paint'));
        gates[5]!.resolve();
        await vi.waitFor(() => expect(concurrent).toBe(0));
        expect(maxConcurrent).toBe(1);

        channel.close();
    });

    it('keeps healthy reconnects stable, coalesces a dropped transport, and repaints through one replacement', async () => {
        let attachCalls = 0;
        let releaseDelayedAttach: (() => void) | undefined;
        const delayedAttach = new Promise<void>((resolve) => {
            releaseDelayedAttach = resolve;
        });
        mocks.request.mockImplementation((type: string) => {
            if (type !== 'terminal.attach') return Promise.resolve({});
            attachCalls += 1;
            return attachCalls === 2 ? delayedAttach : Promise.resolve({});
        });

        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        const first = FakeWebSocket.instances[0]!;
        first.open();
        first.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'paint' }) });

        channel.reconnect();
        channel.reconnect();
        expect(attachCalls).toBe(1);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(first.close).not.toHaveBeenCalled();

        vi.useFakeTimers();
        first.drop();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(attachCalls).toBe(2);

        channel.reconnect();
        channel.reconnect();
        expect(attachCalls).toBe(2);

        releaseDelayedAttach?.();
        vi.useRealTimers();
        await vi.waitFor(() => expect(FakeWebSocket.instances[1]).toBeDefined());
        const replacement = FakeWebSocket.instances[1]!;
        replacement.open();
        replacement.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'repaint' }) });

        // A late duplicate close from the old transport cannot schedule over
        // the live replacement.
        vi.useFakeTimers();
        first.onclose?.();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(attachCalls).toBe(2);
        expect(replacement.readyState).toBe(FakeWebSocket.OPEN);

        channel.repaint();
        vi.useRealTimers();
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
        expect(attachCalls).toBe(3);
        expect(replacement.close).toHaveBeenCalledTimes(1);

        channel.close();
        expect(readConnectionDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({ event: 'terminal.channel', phase: 'attach', outcome: 'ok' }),
            expect.objectContaining({ event: 'terminal.channel', phase: 'socket-open', outcome: 'ok' }),
            expect.objectContaining({ event: 'terminal.channel', phase: 'live', outcome: 'ok' }),
            expect.objectContaining({ event: 'terminal.channel', phase: 'reconnecting', outcome: 'ok' }),
        ]));
    });

    it('stops vouching for an open pane after a known transport failure until the host answers again', async () => {
        const { storage } = await import('@/catalog/store');
        mocks.request.mockResolvedValue({});
        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 80, rows: 24 } });
        const states: string[] = [];
        channel.onState((state) => states.push(state));
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        const socket = FakeWebSocket.instances[0]!;
        socket.open();
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'paint' }) });
        await vi.waitFor(() => expect(states.at(-1)).toBe('live'));

        // Relay paused: a request on the machine transport timed out while this
        // pane's socket stayed open. Nobody can say the host is there.
        storage.getState().setSocketStatus('error');
        expect(states.at(-1)).toBe('unconfirmed');
        // The transport re-establishing its route is not evidence yet.
        storage.getState().setSocketStatus('connecting');
        expect(states.at(-1)).toBe('unconfirmed');
        // An authenticated host frame on the transport is.
        storage.getState().setSocketStatus('connected');
        expect(states.at(-1)).toBe('live');

        // A lost route, then this pane painting again, clears it just the same.
        storage.getState().setSocketStatus('disconnected');
        expect(states.at(-1)).toBe('unconfirmed');
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'more' }) });
        await vi.waitFor(() => expect(states.at(-1)).toBe('live'));

        // An actual re-attach of this pane reads as reconnecting, never as unconfirmed.
        storage.getState().setSocketStatus('error');
        vi.useFakeTimers();
        socket.drop();
        expect(states.at(-1)).toBe('reconnecting');
        vi.useRealTimers();

        channel.close();
        const settled = states.length;
        storage.getState().setSocketStatus('connected');
        expect(states).toHaveLength(settled);
        expect(states).toEqual(['connecting', 'live', 'unconfirmed', 'live', 'unconfirmed', 'live', 'unconfirmed', 'reconnecting']);
    });

    it('keeps the open pane usable across agent exit, shell input and a new agent', async () => {
        mocks.request.mockResolvedValue({});
        const catalog = (route: string, paneId = 'pane-a') => ({ workspaces: [{
            workspaceId: 'workspace-a', label: 'Work', focused: true, agentStatus: 'idle', tabs: [{ tabId: 'tab-a', focused: true, agentStatus: 'idle', panes: [
                { paneId, tabId: 'tab-a', focused: true, sessionId: route, agentStatus: 'idle' },
                { paneId: 'pane-other', tabId: 'tab-a', focused: false, sessionId: 'other-agent', agentStatus: 'working' },
            ] }],
        }] as HerdrTreeWorkspace[], loaded: true });
        mocks.focused = true;
        mocks.catalog = catalog('first-agent');
        let rendered: ReturnType<typeof TestRenderer.create>;
        await TestRenderer.act(async () => { rendered = TestRenderer.create(React.createElement(TerminalRoute, { id: 'first-agent' })); });
        try {
            await vi.waitFor(() => expect(mocks.terminalChannels.has('first-agent')).toBe(true));
            const first = FakeWebSocket.instances.at(-1)!;
            first.open();
            mocks.focused = false; // A file viewer above this route must stay open.
            await TestRenderer.act(async () => {
                mocks.catalog = catalog('shell:work-pane');
                mocks.catalogListeners.forEach((listener) => listener());
            });
            expect(mocks.replace).not.toHaveBeenCalled();
            expect(first.close).not.toHaveBeenCalled();
            mocks.focused = true;
            await TestRenderer.act(async () => { rendered!.update(React.createElement(TerminalRoute, { id: 'first-agent' })); });
            expect(mocks.replace).toHaveBeenLastCalledWith('/session/shell%3Awork-pane');
            await vi.waitFor(() => expect(mocks.terminalChannels.has('shell:work-pane')).toBe(true));
            expect(first.close).toHaveBeenCalledOnce();
            const shell = FakeWebSocket.instances.at(-1)!;
            shell.open();
            mocks.terminalChannels.get('shell:work-pane')!.sendText('pwd\n');
            await TestRenderer.act(async () => {}); // input flushes on a microtask
            expect(JSON.parse(shell.send.mock.calls.at(-1)![0] as string)).toEqual({ type: 'terminal.input', text: 'pwd\n' });
            await TestRenderer.act(async () => { rendered!.update(React.createElement(TerminalRoute, { id: 'shell:work-pane' })); });
            await TestRenderer.act(async () => {
                mocks.catalog = catalog('second-agent');
                mocks.catalogListeners.forEach((listener) => listener());
            });
            expect(mocks.replace).toHaveBeenLastCalledWith('/session/second-agent');
            await vi.waitFor(() => expect(mocks.terminalChannels.has('second-agent')).toBe(true));
            expect(shell.close).toHaveBeenCalledOnce();
            const second = FakeWebSocket.instances.at(-1)!;
            second.open();
            mocks.terminalChannels.get('second-agent')!.sendText('Continue');
            await TestRenderer.act(async () => {}); // input flushes on a microtask
            expect(JSON.parse(second.send.mock.calls.at(-1)![0] as string).text).toBe('Continue');
            expect(mocks.terminalMounts).toEqual(['first-agent', 'shell:work-pane', 'second-agent']);
            await TestRenderer.act(async () => { rendered!.update(React.createElement(TerminalRoute, { id: 'second-agent' })); });
            // Closing this pane does not authorize following another pane or old history.
            mocks.replace.mockClear();
            await TestRenderer.act(async () => {
                mocks.catalog = catalog('unrelated-agent', 'pane-different');
                mocks.catalogListeners.forEach((listener) => listener());
            });
            expect(mocks.replace).not.toHaveBeenCalled();
            await TestRenderer.act(async () => { rendered!.update(React.createElement(TerminalRoute, { id: 'historical-agent' })); });
            expect(mocks.replace).not.toHaveBeenCalled();
            expect(mocks.terminalMounts).not.toContain('other-agent');
            expect(mocks.terminalMounts).not.toContain('unrelated-agent');
        } finally { await TestRenderer.act(async () => { rendered!.unmount(); }); }
    });

    it('records first-frame once and finalizes received/written counts without identifiers', async () => {
        mocks.request.mockResolvedValue({});
        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        const socket = FakeWebSocket.instances[0]!;
        socket.open();
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'full-frame' }) });
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'second' }) });
        await vi.waitFor(() => {
            expect(readConnectionDiagnostics().some((event) => event.event === 'terminal.first-frame')).toBe(true);
        });
        expect(readConnectionDiagnostics().filter((event) => event.event === 'terminal.first-frame')).toHaveLength(1);
        expect(readConnectionDiagnostics().filter((event) => event.event === 'terminal.frames')).toEqual([]);
        const live = formatConnectionDiagnosticsForReport();
        expect(live).toMatch(/Redacted: durations, counts, and enums only/);
        expect(live).toMatch(/terminal\.first-frame \d+ms/);
        expect(live).toMatch(/terminal\.frames live received=2 written=0/);
        channel.recordFrameWritten();
        channel.recordFrameWritten();
        expect(formatConnectionDiagnosticsForReport()).toMatch(/terminal\.frames live received=2 written=2/);
        channel.close();
        expect(readConnectionDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({ event: 'terminal.first-frame' }),
            expect.objectContaining({ event: 'terminal.frames', received: 2, written: 2 }),
        ]));
        const report = formatConnectionDiagnosticsForReport();
        expect(report).toMatch(/terminal\.frames received=2 written=2/);
        expect(report).not.toMatch(/terminal\.frames live /);
        expect(report).not.toMatch(/full-frame|second|pp_|pwt-|devtok_|machine-|session-/);
        channel.recordFrameWritten();
        expect(readConnectionDiagnostics().filter((event) => event.event === 'terminal.frames')).toHaveLength(1);
    });

    it('joins same-task keystrokes into one input frame and still flushes each kind in order', async () => {
        mocks.request.mockResolvedValue({});
        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        const socket = FakeWebSocket.instances[0]!;
        socket.open();

        // Two keystrokes in one task: one frame, joined bytes. The bytes key
        // that follows is a different wire kind, so it goes after, not inside.
        channel.sendText('a');
        channel.sendText('b');
        channel.sendBytes(encodeBase64(new TextEncoder().encode('c')));
        await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
        expect(JSON.parse(socket.send.mock.calls[0]![0] as string)).toEqual({ type: 'terminal.input', text: 'ab' });
        expect(JSON.parse(socket.send.mock.calls[1]![0] as string)).toEqual({
            type: 'terminal.input',
            bytes: encodeBase64(new TextEncoder().encode('c')),
        });

        // An isolated key still flushes within the same task: no artificial
        // delay on the common single-keystroke path.
        channel.sendText('x');
        await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(3));
        expect(JSON.parse(socket.send.mock.calls[2]![0] as string)).toEqual({ type: 'terminal.input', text: 'x' });
        channel.close();
    });

    it('echoes printable input locally as dimmed predictions that never masquerade as host output', async () => {
        mocks.request.mockResolvedValue({});
        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        const socket = FakeWebSocket.instances[0]!;
        socket.open();
        // The host must answer before the pane counts as live.
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'paint' }) });
        const predicted: string[] = [];
        const host: string[] = [];
        channel.onPredictedData((bytes) => predicted.push(bytes));
        channel.onData((bytes) => host.push(bytes));

        // Printable text (including multibyte) predicts once, SGR-faint.
        channel.sendText('héllo');
        expect(predicted).toEqual([encodeBase64(new TextEncoder().encode('\x1b[2mhéllo\x1b[22m'))]);
        expect(host).toEqual(['paint']);

        // Control characters are never predicted: the real output is the truth.
        channel.sendText('pwd\n');
        channel.sendBytes(encodeBase64(new TextEncoder().encode('\x1b[A')));
        expect(predicted).toHaveLength(1);
        expect(host).toEqual(['paint']);
        channel.close();
    });
});

describe('recentTerminalLinks', () => {
    it('keeps a bounded latest-first list of safe visible URLs', async () => {
        const { recordTerminalOutput, recentTerminalLinks, clearTerminalOutput, setTerminalColumns } = await import('./recentOutput');
        const { encodeBase64 } = await import('@/encryption/base64');
        const record = (sessionId: string, text: string) => recordTerminalOutput(sessionId, encodeBase64(new TextEncoder().encode(text)));

        clearTerminalOutput('s1');
        record('s1', '\x1b[32mServing on https://localhost:8901/index.html.\x1b[0m then http://example.com/a?x=1');
        record('s1', '\n\x1b]8;;https://hidden.example');
        record('s1', '\x07again https://localhost:8901/index.html. https://safe.example/\u202eevil https://user:secret@evil.example/ https://exa\x1b(');
        record('s1', 'Bmple.com');
        expect(recentTerminalLinks('s1')).toEqual(['https://example.com/', 'https://localhost:8901/index.html', 'http://example.com/a?x=1']);

        const columns = 80;
        const longUrl = `https://example.com/releases/(latest)/download?token=${'a'.repeat(320)}&source=terminal`;
        const wrappedRows = longUrl.match(new RegExp(`.{1,${columns}}`, 'g')) ?? [];
        expect(wrappedRows).toHaveLength(5);
        clearTerminalOutput('long');
        setTerminalColumns('long', columns);
        wrappedRows.forEach((row, index) => record('long', `${row}${index === wrappedRows.length - 1 ? '' : '\r\n'}`));
        const links = recentTerminalLinks('long');
        expect(links).toEqual([longUrl]);
        expect(recentTerminalLinks('long')).toBe(links);
        setTerminalColumns('long', 0);
        expect(recentTerminalLinks('long')).not.toBe(links);
        setTerminalColumns('long', columns);
        expect(recentTerminalLinks('long')).toEqual([longUrl]);
        record('long', ' https://next.example/');
        expect(recentTerminalLinks('long')).toEqual(['https://next.example/', longUrl]);

        clearTerminalOutput('split-scheme');
        record('split-scheme', 'ht');
        record('split-scheme', 'tps://split.example/path');

        clearTerminalOutput('hard-break');
        setTerminalColumns('hard-break', columns);
        record('hard-break', 'https://short.example/path\nnot-part-of-the-link');
        expect(recentTerminalLinks('hard-break')).toEqual(['https://short.example/path']);

        clearTerminalOutput('s2');
        for (let index = 0; index < 10; index++) record('s2', ` https://link-${index}.example`);
        expect(recentTerminalLinks('s2')).toEqual(Array.from({ length: 8 }, (_, index) => `https://link-${9 - index}.example/`));

        for (let index = 0; index < 33; index++) record(`lru-${index}`, ' https://example.com');
        expect(recentTerminalLinks('lru-0')).toEqual([]);
        expect(recentTerminalLinks('unknown')).toEqual([]);
    });
});
