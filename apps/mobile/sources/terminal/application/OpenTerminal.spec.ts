import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    fetch: vi.fn(),
}));

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => ({
        relayUrl: 'ws://relay.test',
        machineId: 'machine',
        token: 'devtok_test',
    }),
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

import { openTerminal } from './OpenTerminal';

describe('openTerminal reconnect ownership', () => {
    beforeEach(() => {
        mocks.request.mockReset();
        mocks.fetch.mockReset();
        mocks.fetch.mockResolvedValue({
            ok: true,
            status: 201,
            json: async () => ({ ticket: 'pwt-test', expires_in: 60 }),
        });
        FakeWebSocket.instances.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
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
    });
});

describe('recentTerminalLinks', () => {
    it('keeps a bounded latest-first list of safe visible URLs', async () => {
        const { recordTerminalOutput, recentTerminalLinks, viewportTerminalLinks, clearTerminalOutput, setTerminalColumns } = await import('./recentOutput');
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
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(viewportTerminalLinks('long')).toEqual([longUrl]);
        expect(viewportTerminalLinks('split-scheme')).toEqual(['https://split.example/path']);

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

describe('viewportTerminalLinks', () => {
    it('surfaces only the scroll burst’s links, not the older tail', async () => {
        vi.useFakeTimers();
        try {
            const { recordTerminalOutput, beginViewportCapture, viewportTerminalLinks, recentTerminalLinks, clearTerminalOutput } = await import('./recentOutput');
            const { encodeBase64 } = await import('@/encryption/base64');
            const record = (text: string) => recordTerminalOutput('scroll', encodeBase64(new TextEncoder().encode(text)));

            clearTerminalOutput('scroll');
            record('old boot log: serving https://old-tail.example/ since yesterday');

            // A scroll gesture: herdr answers with full-screen repaint frames.
            beginViewportCapture('scroll');
            record('\x1b[2J\x1b[Hrepainted screen  Local: http://localhost:3210/');
            record('  ready in 412ms');
            // The regex runs once per gesture: nothing before the debounce.
            expect(viewportTerminalLinks('scroll')).toEqual([]);
            await vi.advanceTimersByTimeAsync(120);
            expect(viewportTerminalLinks('scroll')).toEqual(['http://localhost:3210/']);
            // The tail still holds both, for the ⋮ menu.
            expect(recentTerminalLinks('scroll')).toEqual(['http://localhost:3210/', 'https://old-tail.example/']);

            // Scrolling past the link clears the chip.
            beginViewportCapture('scroll');
            record('\x1b[2J\x1b[Han older screen with no links at all');
            await vi.advanceTimersByTimeAsync(120);
            expect(viewportTerminalLinks('scroll')).toEqual([]);
            clearTerminalOutput('scroll');
        } finally {
            vi.useRealTimers();
        }
    });
});
