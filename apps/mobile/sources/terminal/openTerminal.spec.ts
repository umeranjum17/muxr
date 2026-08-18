import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
}));

vi.mock('@/state/connectionSettings', () => ({
    getCachedConnectionSettings: () => ({
        relayUrl: 'ws://relay.test',
        machineId: 'machine',
        token: '',
    }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { request: mocks.request },
}));

vi.mock('@/state/hostedE2ee', () => ({
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

    close(): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.drop();
    }
}

vi.stubGlobal('WebSocket', FakeWebSocket);

import { openTerminal } from './openTerminal';

describe('openTerminal reconnect ownership', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.request.mockReset();
        FakeWebSocket.instances.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('replays the first paint when it arrives before the native view subscribes', async () => {
        mocks.request.mockResolvedValue({});
        const channel = await openTerminal('session', { cols: 100, rows: 30 });
        const socket = FakeWebSocket.instances[0];
        expect(socket).toBeDefined();
        socket!.open();
        socket!.onmessage?.({ data: JSON.stringify({ type: 'terminal.frame', bytes: 'full-paint' }) });

        const frames: string[] = [];
        channel.onData((bytes) => frames.push(bytes));
        expect(frames).toEqual(['full-paint']);

        channel.close();
    });

    it('coalesces focus retries under a delayed attach and ignores a stale close', async () => {
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

        const channel = await openTerminal('session', { cols: 100, rows: 30 });
        const first = FakeWebSocket.instances[0];
        expect(first).toBeDefined();
        first!.open();
        first!.drop();

        await vi.advanceTimersByTimeAsync(1_500);
        expect(attachCalls).toBe(2);

        channel.reconnect();
        channel.reconnect();
        expect(attachCalls).toBe(2);

        releaseDelayedAttach?.();
        await vi.runAllTicks();
        const replacement = FakeWebSocket.instances[1];
        expect(replacement).toBeDefined();
        replacement!.open();

        // A late duplicate close from the old transport cannot schedule over
        // the live replacement.
        first!.onclose?.();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(attachCalls).toBe(2);
        expect(replacement!.readyState).toBe(FakeWebSocket.OPEN);

        channel.close();
    });
});

describe('recentTerminalLinks', () => {
    it('keeps a bounded latest-first list of safe visible URLs', async () => {
        const { recordTerminalOutput, recentTerminalLinks, clearTerminalOutput } = await import('./recentOutput');
        const { encodeBase64 } = await import('@/encryption/base64');
        const record = (sessionId: string, text: string) => recordTerminalOutput(sessionId, encodeBase64(new TextEncoder().encode(text)));

        clearTerminalOutput('s1');
        record('s1', '\x1b[32mServing on https://localhost:8901/index.html.\x1b[0m then http://example.com/a?x=1');
        record('s1', '\n\x1b]8;;https://hidden.example');
        record('s1', '\x07again https://localhost:8901/index.html. https://safe.example/\u202eevil https://user:secret@evil.example/ https://exa\x1b(');
        record('s1', 'Bmple.com');
        expect(recentTerminalLinks('s1')).toEqual(['https://example.com/', 'https://localhost:8901/index.html', 'http://example.com/a?x=1']);

        clearTerminalOutput('s2');
        for (let index = 0; index < 10; index++) record('s2', ` https://link-${index}.example`);
        expect(recentTerminalLinks('s2')).toEqual(Array.from({ length: 8 }, (_, index) => `https://link-${9 - index}.example/`));

        for (let index = 0; index < 33; index++) record(`lru-${index}`, ' https://example.com');
        expect(recentTerminalLinks('lru-0')).toEqual([]);
        expect(recentTerminalLinks('unknown')).toEqual([]);
    });
});
