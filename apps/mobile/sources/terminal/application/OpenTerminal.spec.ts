import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
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
import { createTerminalWritePump } from './terminalWritePump';
import { readConnectionDiagnostics, resetConnectionDiagnostics } from '@/catalog/infrastructure/connectionDiagnostics';

describe('openTerminal reconnect ownership', () => {
    beforeEach(() => {
        mocks.request.mockReset();
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
        const graphics: boolean[] = [];
        channel.onGraphics((active) => graphics.push(active));
        expect(graphics).toEqual([false]);
        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'full-paint', graphics: true }) });

        const frames: Array<{ bytes: string; graphics?: boolean }> = [];
        channel.onData((bytes, graphicsFlag) => frames.push({ bytes, graphics: graphicsFlag }));
        expect(frames).toEqual([{ bytes: 'full-paint', graphics: true }]);
        expect(graphics).toEqual([false, true]);

        socket.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'ansi', graphics: false }) });
        expect(frames).toEqual([{ bytes: 'full-paint', graphics: true }, { bytes: 'ansi', graphics: false }]);
        expect(graphics).toEqual([false, true, false]);

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

        channel.close();
        expect(graphics).toEqual([false, true, false]);
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
