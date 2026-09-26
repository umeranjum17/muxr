import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hosted regression: connection settings carry no usable token in hosted mode
 * (the account/device credential lives on the grant). The terminal socket used
 * to fall back to a legacy no-token URL, which the relay authenticates into the
 * anonymous 'local' namespace while the host joins the channel by ticket under
 * its account -- the two sides never pair and the screen retries forever.
 */

const grant = {
    machineId: 'machine',
    deviceId: 'device-1',
    keyVersion: 2,
    dataKey: 'data',
    ingressKey: 'ingress',
    expiresAt: Date.now() + 60_000,
    deviceKey: { publicKey: 'pk', secretKey: 'sk' },
    machineSigningPublicKey: 'msp',
    machineBoxPublicKey: 'mbp',
    credential: 'pck_device_cred',
    relayUrl: 'wss://hosted.relay.test',
};

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    seal: vi.fn((channel: string, streamId: string, plaintext: string) => ({ payload: `sealed:${plaintext}`, sequence: 7 })),
    open: vi.fn(async (channel: string, streamId: string, payload: string) => payload.slice('sealed:'.length)),
    fetch: vi.fn(),
    refresh: vi.fn(),
    openTerminalLink: vi.fn(),
}));

vi.mock('@/connection', () => ({
    channelRelayUrl: async (relayUrl: string) => relayUrl,
    getCachedConnectionSettings: () => ({
        mode: 'hosted',
        relayUrl: 'ws://relay.test',
        machineId: 'machine',
        token: '',
    }),
}));

vi.mock('@/catalog/sync', () => ({
    sync: { request: mocks.request, openTerminalLink: mocks.openTerminalLink },
}));

vi.mock('@/catalog/store', async () => {
    const { create } = await import('zustand');
    return { storage: create<{ socketStatus: string }>()(() => ({ socketStatus: 'connected' })) };
});

vi.mock('@/pairing/e2ee', () => ({
    getCachedHostedGrant: () => grant,
    refreshHostedGrant: mocks.refresh,
    DeviceV2Crypto: class {
        seal = mocks.seal;
        open = mocks.open;
    },
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

    close(): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('fetch', mocks.fetch);

import { openTerminal } from './OpenTerminal';

describe('openTerminal hosted transport', () => {
    beforeEach(() => {
        mocks.request.mockReset();
        mocks.request.mockResolvedValue({});
        mocks.openTerminalLink.mockReset();
        mocks.openTerminalLink.mockReturnValue(undefined);
        mocks.seal.mockClear();
        mocks.open.mockClear();
        mocks.fetch.mockReset();
        mocks.refresh.mockReset();
        mocks.refresh.mockResolvedValue(grant);
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

    it('attaches on the link without a relay socket and consumes a final sealed close before stream end', async () => {
        let line!: (value: string) => void;
        let end!: () => void;
        const transport = {
            write: vi.fn(async () => undefined),
            close: vi.fn(),
            onLine: vi.fn((listener: (value: string) => void) => { line = listener; return () => undefined; }),
            onEnd: vi.fn((listener: () => void) => { end = listener; return () => undefined; }),
        };
        mocks.openTerminalLink.mockReturnValue(Promise.resolve(transport));
        const opening = openTerminal({ agentRoute: 'session-1', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(transport.onLine).toHaveBeenCalled());
        const requestId = mocks.openTerminalLink.mock.calls[0]![0].requestId as string;
        line(JSON.stringify({ header: {
            machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
            streamId: mocks.openTerminalLink.mock.calls[0]![0].channel, keyVersion: 2, seq: 6,
        }, payload: `sealed:${JSON.stringify({ type: 'terminal.frame', bytes: 'aGk=' })}` }));
        line(JSON.stringify({ header: {
            machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
            streamId: mocks.openTerminalLink.mock.calls[0]![0].channel, keyVersion: 2, seq: 7,
        }, payload: `sealed:${JSON.stringify({ type: 'result', requestId, ok: true, data: { paneId: 'pane' } })}` }));
        const channel = await opening;
        const data: string[] = [];
        channel.onData((bytes) => data.push(bytes));
        expect(data).toEqual(['aGk=']);
        expect(FakeWebSocket.instances).toHaveLength(0);
        const scroll: Array<{ offsetFromBottom: number; maxOffsetFromBottom: number }> = [];
        channel.onScrollState((state) => scroll.push(state));
        const states: string[] = [];
        channel.onState((state) => states.push(state));
        const streamId = mocks.openTerminalLink.mock.calls[0]![0].channel;
        line(JSON.stringify({ header: { machineId: 'machine', senderId: 'machine', recipientId: '*',
            channel: 'terminal', streamId, keyVersion: 2, seq: 8 },
        payload: `sealed:${JSON.stringify({ type: 'terminal.scroll-state', offsetFromBottom: 'bad', maxOffsetFromBottom: 12 })}` }));
        line(JSON.stringify({ header: { machineId: 'machine', senderId: 'machine', recipientId: '*',
            channel: 'terminal', streamId, keyVersion: 2, seq: 9 },
        payload: `sealed:${JSON.stringify({ type: 'terminal.scroll-state', offsetFromBottom: 2, maxOffsetFromBottom: 12 })}` }));
        await vi.waitFor(() => expect(scroll).toEqual([{ offsetFromBottom: 2, maxOffsetFromBottom: 12 }]));
        const closes: (string | undefined)[] = [];
        channel.onClose((reason) => closes.push(reason));
        let decrypt!: (value: string) => void;
        mocks.open.mockImplementationOnce(() => new Promise<string>((resolve) => { decrypt = resolve; }));
        line(JSON.stringify({ header: {
            machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
            streamId: mocks.openTerminalLink.mock.calls[0]![0].channel, keyVersion: 2, seq: 10,
        }, payload: 'delayed' }));
        await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(5));
        end();
        decrypt(JSON.stringify({ type: 'terminal.closed', reason: 'herdr stream exited' }));
        await vi.waitFor(() => expect(closes).toEqual(['herdr stream exited']));
        expect(states.at(-1)).toBe('live');
        expect(FakeWebSocket.instances).toHaveLength(0);
        channel.close();

        const closedEarly = openTerminal({ agentRoute: 'session-1', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(transport.onLine).toHaveBeenCalledTimes(2));
        const next = mocks.openTerminalLink.mock.calls[1]![0] as { requestId: string; channel: string };
        line(JSON.stringify({ header: {
            machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
            streamId: next.channel, keyVersion: 2, seq: 9,
        }, payload: `sealed:${JSON.stringify({ type: 'terminal.closed', reason: 'pane ended early' })}` }));
        line(JSON.stringify({ header: {
            machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
            streamId: next.channel, keyVersion: 2, seq: 10,
        }, payload: `sealed:${JSON.stringify({ type: 'result', requestId: next.requestId, ok: true, data: { paneId: 'pane' } })}` }));
        const earlyChannel = await closedEarly;
        const earlyCloses: (string | undefined)[] = [];
        earlyChannel.onClose((reason) => earlyCloses.push(reason));
        expect(earlyCloses).toEqual(['pane ended early']);
        expect(FakeWebSocket.instances).toHaveLength(0);
        earlyChannel.close();

        const taken = openTerminal({ agentRoute: 'session-1', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(transport.onLine).toHaveBeenCalledTimes(3));
        const takeover = mocks.openTerminalLink.mock.calls[2]![0] as { requestId: string; channel: string };
        line(JSON.stringify({ header: { machineId: 'machine', senderId: 'machine', recipientId: '*',
            channel: 'terminal', streamId: takeover.channel, keyVersion: 2, seq: 11 },
        payload: `sealed:${JSON.stringify({ type: 'result', requestId: takeover.requestId, ok: true })}` }));
        const takenChannel = await taken;
        const takenCloses: (string | undefined)[] = [];
        takenChannel.onClose((reason) => takenCloses.push(reason));
        line(JSON.stringify({ header: { machineId: 'machine', senderId: 'machine', recipientId: '*',
            channel: 'terminal', streamId: takeover.channel, keyVersion: 2, seq: 12 },
        payload: `sealed:${JSON.stringify({ type: 'terminal.closed', reason: 'control moved to another device' })}` }));
        await vi.waitFor(() => expect(takenCloses).toEqual(['control moved to another device']));
        takenChannel.reconnect(true);
        expect(transport.close).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => expect(transport.onLine).toHaveBeenCalledTimes(4));
        const retry = mocks.openTerminalLink.mock.calls[3]![0] as { requestId: string; channel: string; takeover: boolean };
        expect(retry.takeover).toBe(true);
        line(JSON.stringify({ header: { machineId: 'machine', senderId: 'machine', recipientId: '*',
            channel: 'terminal', streamId: retry.channel, keyVersion: 2, seq: 13 },
        payload: `sealed:${JSON.stringify({ type: 'result', requestId: retry.requestId, ok: true })}` }));
        await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(10));
        end();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(FakeWebSocket.instances).toHaveLength(0);
        takenChannel.close();

        const dropped = openTerminal({ agentRoute: 'session-1', size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(transport.onLine).toHaveBeenCalledTimes(5));
        const last = mocks.openTerminalLink.mock.calls[4]![0] as { requestId: string; channel: string };
        line(JSON.stringify({ header: { machineId: 'machine', senderId: 'machine', recipientId: '*',
            channel: 'terminal', streamId: last.channel, keyVersion: 2, seq: 14 },
        payload: `sealed:${JSON.stringify({ type: 'result', requestId: last.requestId, ok: true })}` }));
        end();
        const droppedChannel = await dropped;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(mocks.request.mock.calls.filter(([method]) => method === 'terminal.attach')).toHaveLength(0);
        droppedChannel.close();
    });

    it('joins the channel by ticket under the grant credential, then flows sealed frames', async () => {
        const initialGrant = Promise.withResolvers<typeof grant>();
        mocks.refresh.mockReturnValueOnce(initialGrant.promise);
        const abandoned = new AbortController();
        const opening = openTerminal({ agentRoute: 'hidden-session', size: { cols: 100, rows: 30 }, signal: abandoned.signal });
        const outcome = opening.then((opened) => { opened.close(); return 'opened'; }, () => 'cancelled');
        abandoned.abort();
        initialGrant.resolve(grant);
        expect(await outcome).toBe('cancelled');
        expect(mocks.request).not.toHaveBeenCalled();
        expect(FakeWebSocket.instances).toHaveLength(0);

        const visible = new AbortController();
        const channel = await openTerminal({ agentRoute: 'session-1', size: { cols: 100, rows: 30 }, signal: visible.signal });
        await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));

        // The ticket is minted against the grant's relay with the grant
        // credential -- never the empty connection-settings token.
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        const [ticketUrl, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
        expect(ticketUrl).toBe('https://hosted.relay.test/v1/ws-tickets');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer pck_device_cred');
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ machineSlug: 'machine', role: 'client', transport: 'terminal' });
        expect(typeof body.channel).toBe('string');

        const socket = FakeWebSocket.instances[0]!;
        expect(socket.url).toBe(`wss://hosted.relay.test/terminal?ticket=pwt-test`);

        const states: string[] = [];
        channel.onState((state) => states.push(state));
        const data: string[] = [];
        channel.onData((bytes) => data.push(bytes));
        socket.open();
        expect(states).toEqual(['connecting']);

        // Host -> phone: a sealed v2 envelope decrypts to a terminal frame.
        const streamId = body.channel as string;
        socket.onmessage?.({
            data: JSON.stringify({
                header: {
                    machineId: 'machine',
                    senderId: 'machine',
                    recipientId: '*',
                    channel: 'terminal',
                    streamId,
                    keyVersion: 2,
                    seq: 7,
                    at: Date.now(),
                },
                payload: `sealed:${JSON.stringify({ type: 'terminal.frame', bytes: 'aGk=' })}`,
            }),
        });
        await vi.waitFor(() => expect(data).toEqual(['aGk=']));
        expect(states).toEqual(['connecting', 'live']);
        expect(mocks.open).toHaveBeenCalledWith('terminal', streamId, expect.any(String), 7);

        // Phone -> host: input leaves sealed on the same channel.
        channel.sendText('ls');
        await Promise.resolve(); // input flushes on a microtask
        expect(mocks.seal).toHaveBeenCalledWith('terminal', streamId, JSON.stringify({ type: 'terminal.input', text: 'ls' }));
        expect(socket.send).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(socket.send.mock.calls[0]![0] as string) as { header: Record<string, unknown>; payload: string };
        expect(sent.header).toMatchObject({
            machineId: 'machine',
            senderId: 'device-1',
            recipientId: 'machine',
            channel: 'terminal',
            streamId,
            keyVersion: 2,
        });
        expect(sent.payload).toBe(`sealed:${JSON.stringify({ type: 'terminal.input', text: 'ls' })}`);

        // A takeover is terminal for automatic focus/foreground retries, but
        // tapping the visible retry control is the explicit action to retake it.
        socket.onmessage?.({
            data: JSON.stringify({
                header: {
                    machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
                    streamId, keyVersion: 2, seq: 8, at: Date.now(),
                },
                payload: `sealed:${JSON.stringify({ type: 'terminal.closed', reason: 'control moved to another device' })}`,
            }),
        });
        await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
        channel.reconnect();
        expect(mocks.request).toHaveBeenCalledTimes(1);
        channel.reconnect(true);
        expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));

        // A delayed decrypt from a retired stream must not close its replacement.
        const retired = FakeWebSocket.instances[1]!;
        retired.open();
        let finishOld!: (frame: string) => void;
        mocks.open.mockImplementationOnce(() => new Promise<string>((resolve) => { finishOld = resolve; }));
        const closes: (string | undefined)[] = [];
        channel.onClose((reason) => closes.push(reason));
        retired.onmessage?.({ data: JSON.stringify({ header: {
            machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
            streamId, keyVersion: 2, seq: 9, at: Date.now(),
        }, payload: 'delayed' }) });
        channel.repaint();
        await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(3));
        const replacement = FakeWebSocket.instances[2]!;
        replacement.open();
        finishOld(JSON.stringify({ type: 'terminal.closed', reason: 'old stream ended' }));
        await Promise.resolve();
        await Promise.resolve();
        expect(closes).toEqual([]);
        replacement.onmessage?.({ data: JSON.stringify({ header: {
            machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
            streamId, keyVersion: 2, seq: 10, at: Date.now(),
        }, payload: `sealed:${JSON.stringify({ type: 'terminal.frame', bytes: 'bmV3' })}` }) });
        await vi.waitFor(() => expect(data.at(-1)).toBe('bmV3'));

        // An open relay with no host frame is still reconnecting and has a deadline.
        vi.useFakeTimers();
        channel.repaint();
        await vi.advanceTimersByTimeAsync(0);
        const silent = FakeWebSocket.instances[3]!;
        silent.open();
        expect(states.at(-1)).toBe('reconnecting');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(silent.readyState).toBe(FakeWebSocket.CLOSED);
        await vi.advanceTimersByTimeAsync(1500);
        expect(FakeWebSocket.instances.length).toBe(5);
        // Leaving during a reconnect grant refresh cannot retake the pane later.
        const attaches = mocks.request.mock.calls.filter(([method]) => method === 'terminal.attach').length;
        const reconnectGrant = Promise.withResolvers<typeof grant>();
        mocks.refresh.mockReturnValueOnce(reconnectGrant.promise);
        channel.repaint();
        visible.abort();
        reconnectGrant.resolve(grant);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.request.mock.calls.filter(([method]) => method === 'terminal.attach')).toHaveLength(attaches);
        expect(FakeWebSocket.instances).toHaveLength(5);
        channel.close();
    });
});
