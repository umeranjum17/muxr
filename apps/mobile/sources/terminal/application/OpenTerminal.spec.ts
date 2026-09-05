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
    getCachedConnectionSettings: () => mocks.settings,
}));

vi.mock('@/catalog/sync', () => ({
    sync: { request: mocks.request },
}));

vi.mock('@/pairing/e2ee', () => ({
    getCachedHostedGrant: () => undefined,
    DeviceV2Crypto: class {},
}));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => mocks.focused }));
vi.mock('expo-router', () => ({ router: { replace: mocks.replace } }));
vi.mock('@/catalog/store', async () => {
    const React = await import('react');
    return { useHerdrTree: () => React.useSyncExternalStore(
        (listener) => { mocks.catalogListeners.add(listener); return () => { mocks.catalogListeners.delete(listener); }; },
        () => mocks.catalog,
    ) };
});
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

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { createKittyDecoderState, inflateZlib, materializeKittyCommands, splitKittyFrame } from './kittyDecoder';
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
        const graphics: Array<{ active: boolean; reason?: string }> = [];
        channel.onGraphics((active, reason) => graphics.push({ active, ...(reason === undefined ? {} : { reason }) }));
        expect(graphics).toEqual([{ active: false }]);
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'full-paint', graphics: true }) });

        const frames: Array<{ bytes: string; graphics?: boolean }> = [];
        channel.onData((bytes, graphicsFlag) => frames.push({ bytes, graphics: graphicsFlag }));
        expect(frames).toEqual([{ bytes: 'full-paint', graphics: true }]);
        expect(graphics).toEqual([{ active: false }, { active: true }]);

        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'ansi', graphics: false }) });
        expect(frames).toEqual([{ bytes: 'full-paint', graphics: true }, { bytes: 'ansi', graphics: false }]);
        expect(graphics).toEqual([{ active: false }, { active: true }, { active: false }]);

        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'plain-herdr' }) });
        expect(frames.at(-1)).toEqual({ bytes: 'plain-herdr' });

        const deleteBytes = encodeBase64(new TextEncoder().encode('\x1b_Ga=d,d=A;\x1b\\'));
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: deleteBytes, graphics: false }) });
        expect(frames.at(-1)).toEqual({ bytes: deleteBytes, graphics: false });
        const routed = splitKittyFrame(decodeBase64(deleteBytes), createKittyDecoderState());
        expect(routed.error).toBeUndefined();
        expect(routed.commands).toEqual([{ kind: 'delete-all' }]);
        expect(new TextDecoder().decode(routed.ansi)).toBe('');
        const cleared = await materializeKittyCommands(routed.commands, inflateZlib);
        expect(cleared.deleteAll).toBe(true);
        expect(cleared.placements).toEqual([]);

        socket.onmessage?.({ data: JSON.stringify({
            type: 'terminal.frame',
            bytes: deleteBytes,
            graphics: false,
            graphicsReason: 'retired',
        }) });
        expect(graphics.at(-1)).toEqual({ active: false, reason: 'retired' });
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'draw-again', graphics: true }) });
        expect(graphics.at(-1)).toEqual({ active: true });

        channel.repaint(true);
        expect(graphics.at(-1)).toEqual({ active: false });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith(
            'terminal.attach',
            expect.objectContaining({ graphicsReset: true }),
        ));

        channel.close();
        expect(graphics.at(-1)).toEqual({ active: false });
    });

    it('drives socket frames through one in-flight graphics-aware write pump', async () => {
        mocks.request.mockResolvedValue({});
        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        const socket = FakeWebSocket.instances[0]!;
        socket.open();

        const writes: string[] = [];
        let concurrent = 0;
        let maxConcurrent = 0;
        const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
        const recoveries: unknown[] = [];
        let scheduledId = 0;
        const scheduled = new Set<number>();
        const pump = createTerminalWritePump({
            write: (bytes) => {
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
        channel.onData((bytes, graphics) => {
            pump.push(typeof graphics === 'boolean' ? { bytes, graphics } : { bytes });
        });

        const frame = (bytes: string, graphics?: boolean) => {
            socket.onmessage?.({ data: JSON.stringify(typeof graphics === 'boolean'
                ? { type: 'terminal.frame', bytes, graphics }
                : { type: 'terminal.frame', bytes }) });
        };

        frame('draw-1', true);
        await vi.waitFor(() => expect(writes).toEqual(['draw-1']));
        frame('text-A');
        frame('draw-2', true);
        frame('text-B');
        frame('draw-3', true);
        frame('retire-F', false);
        expect(writes).toEqual(['draw-1']);
        expect(maxConcurrent).toBe(1);

        gates[0]!.resolve();
        await vi.waitFor(() => expect(writes).toEqual(['draw-1', 'text-Atext-B']));
        expect(writes[1]).not.toContain('draw-');
        expect(writes[1]).not.toContain('retire-');
        gates[1]!.resolve();
        await vi.waitFor(() => expect(writes).toEqual(['draw-1', 'text-Atext-B', 'draw-3']));
        gates[2]!.resolve();
        await vi.waitFor(() => expect(writes).toEqual(['draw-1', 'text-Atext-B', 'draw-3', 'retire-F']));
        expect(writes).not.toContain('draw-2');
        gates[3]!.resolve();
        await vi.waitFor(() => expect(concurrent).toBe(0));

        frame('draw-4', true);
        await vi.waitFor(() => expect(writes.at(-1)).toBe('draw-4'));
        frame('draw-5', true);
        frame('draw-6', true);
        expect(writes.filter((item) => item.startsWith('draw-'))).toEqual(['draw-1', 'draw-3', 'draw-4']);
        gates[4]!.resolve();
        await vi.waitFor(() => expect(writes.at(-1)).toBe('draw-6'));
        gates[5]!.resolve();
        await vi.waitFor(() => expect(concurrent).toBe(0));

        frame('text-C');
        await vi.waitFor(() => expect(writes.at(-1)).toBe('text-C'));
        frame('text-D');
        const cancelled = pump.cancel();
        gates[6]!.resolve();
        await cancelled;
        await Promise.resolve();
        expect(writes.at(-1)).toBe('text-C');
        expect(writes).not.toContain('text-D');

        frame('text-E');
        frame('draw-7', true);
        await vi.waitFor(() => expect(writes.at(-1)).toBe('text-E'));
        frame('text-F');
        gates[7]!.reject(undefined);
        await vi.waitFor(() => expect(recoveries).toEqual([undefined]));
        await Promise.resolve();
        expect(writes).not.toContain('draw-7');
        expect(writes).not.toContain('text-F');
        expect(recoveries).toHaveLength(1);
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
        expect(recentTerminalLinks('long')).toEqual([longUrl]);

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
