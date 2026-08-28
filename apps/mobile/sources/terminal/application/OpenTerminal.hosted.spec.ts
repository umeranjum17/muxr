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
}));

vi.mock('@/state/connectionSettings', () => ({
    getCachedConnectionSettings: () => ({
        mode: 'hosted',
        relayUrl: 'ws://relay.test',
        machineId: 'machine',
        token: '',
    }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { request: mocks.request },
}));

vi.mock('@/state/hostedE2ee', () => ({
    getCachedHostedGrant: () => grant,
    refreshHostedGrant: async () => grant,
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
        mocks.seal.mockClear();
        mocks.open.mockClear();
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

    it('joins the channel by ticket under the grant credential, then flows sealed frames', async () => {
        const channel = await openTerminal({ agentRoute: 'session-1', size: { cols: 100, rows: 30 } });
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
        expect(states).toEqual(['live']);

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
        expect(mocks.open).toHaveBeenCalledWith('terminal', streamId, expect.any(String), 7);

        // Phone -> host: input leaves sealed on the same channel.
        channel.sendText('ls');
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

        channel.close();
    });
});
