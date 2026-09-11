import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    request: vi.fn(),
    fetch: vi.fn(),
    startBridge: vi.fn(async (_socket: unknown, _key: unknown, _channel: unknown) => ({
        url: 'https://preview-bridge.test/',
        close: () => undefined,
    })),
    bridgeAvailable: true,
    grant: undefined as
        | { relayUrl: string; credential: string; machineId: string; expiresAt: number }
        | undefined,
    connection: {
        mode: 'local' as 'local' | 'hosted',
        relayUrl: 'ws://127.0.0.1:8892',
        machineId: 'sim',
        token: '',
    },
}));

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => harness.connection,
}));
vi.mock('@/catalog/sync', () => ({ sync: { request: harness.request } }));
vi.mock('@/pairing/e2ee', () => ({
    getCachedHostedGrant: () => harness.grant,
}));
vi.mock('../infrastructure/previewBridge', () => ({
    get previewBridgeAvailable() {
        return harness.bridgeAvailable;
    },
    startPreviewBridge: (socket: unknown, key: unknown, channel: unknown) =>
        harness.startBridge(socket, key, channel),
}));

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((cause?: unknown) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    readonly send = vi.fn();

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    pair(port: number): void {
        this.open();
        this.onmessage?.({ data: JSON.stringify({ type: 'preview.ready', port }) });
    }

    readonly close = vi.fn((): void => {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    });
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('fetch', (...args: unknown[]) => harness.fetch(...args));

import { attachPreviewTunnel, openPreview } from './OpenPreview';

describe('openPreview', () => {
    beforeEach(() => {
        harness.request.mockReset();
        harness.fetch.mockReset();
        harness.grant = undefined;
        harness.connection.mode = 'local';
        harness.connection.relayUrl = 'ws://127.0.0.1:8892';
        harness.connection.machineId = 'sim';
        harness.connection.token = '';
        FakeWebSocket.instances.length = 0;
        harness.fetch.mockResolvedValue({
            ok: true,
            status: 201,
            json: async () => ({ ticket: 'pwt-preview-test' }),
        });
        harness.request.mockResolvedValue({ ok: true, data: null });
    });

    it('uses the Mac loopback directly on the iOS simulator', async () => {
        const preview = await openPreview({ port: 8099, onIosSimulator: true });
        expect(preview.url).toBe('http://127.0.0.1:8099/');
        expect(preview.close()).toBeUndefined();
        expect(harness.request).not.toHaveBeenCalled();
    });

    it('rejects a remote paired machine on the iOS simulator', async () => {
        harness.connection.mode = 'hosted';
        harness.connection.relayUrl = 'wss://remote-machine.tailnet.ts.net';
        harness.connection.machineId = 'remote';

        await expect(openPreview({ port: 8099, onIosSimulator: true })).rejects.toThrow(
            'Preview from a remote machine is unavailable in the iOS Simulator.',
        );
        expect(harness.request).not.toHaveBeenCalled();
    });
});

describe('attachPreviewTunnel hosted grant', () => {
    beforeEach(() => {
        harness.request.mockReset();
        harness.fetch.mockReset();
        harness.startBridge.mockReset();
        harness.startBridge.mockResolvedValue({ url: 'https://preview-bridge.test/', close: () => undefined });
        harness.bridgeAvailable = true;
        harness.grant = undefined;
        harness.connection.mode = 'hosted';
        harness.connection.relayUrl = 'wss://relay.example.ts.net';
        harness.connection.machineId = 'sim';
        harness.connection.token = '';
        FakeWebSocket.instances.length = 0;
        harness.fetch.mockResolvedValue({
            ok: true,
            status: 201,
            json: async () => ({ ticket: 'pwt-preview-test' }),
        });
        harness.request.mockResolvedValue({ ok: true, data: null });
    });

    const grant = () => {
        harness.grant = {
            relayUrl: 'wss://grant-relay.example.ts.net',
            credential: 'devcred_test',
            machineId: 'sim',
            expiresAt: Date.now() + 60_000,
        };
    };

    async function openRawTcp(port = 8099, mode?: 'observe' | 'control') {
        harness.bridgeAvailable = false;
        harness.connection.mode = 'local';
        harness.connection.relayUrl = 'ws://127.0.0.1:8892';
        const opened = attachPreviewTunnel(port, { rawTcp: true, ...(mode === undefined ? {} : { mode }) });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        FakeWebSocket.instances[0]!.pair(44123);
        return opened;
    }

    async function openBridged(port = 8099, mode?: 'observe' | 'control', wsStream = false) {
        harness.bridgeAvailable = true;
        harness.connection.mode = 'hosted';
        harness.connection.relayUrl = 'wss://relay.example.ts.net';
        const opened = attachPreviewTunnel(port, {
            ...(mode === undefined ? {} : { mode }),
            ...(wsStream ? { wsStream: true } : {}),
        });
        await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
        FakeWebSocket.instances[0]!.open();
        FakeWebSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'preview.bridge' }) });
        return opened;
    }

    it('mints the ticket from the hosted grant before host attach, without leaking the credential', async () => {
        grant();
        const tunnel = await openBridged();

        expect(tunnel.url).toBe('https://preview-bridge.test/');

        expect(harness.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = harness.fetch.mock.calls[0] as unknown[] as [
            unknown,
            { headers?: unknown; body?: unknown },
        ];
        expect(String(url)).toBe('https://grant-relay.example.ts.net/v1/ws-tickets');
        expect(init.headers).toMatchObject({ authorization: 'Bearer devcred_test' });
        expect(JSON.parse(String(init.body))).toMatchObject({
            machineSlug: 'sim',
            role: 'client',
            transport: 'preview',
        });

        // Ticket first so a mint failure cannot strand a takeover controller,
        // then the host attach on the same channel.
        const order = [
            harness.fetch.mock.invocationCallOrder[0]!,
            harness.request.mock.invocationCallOrder[0]!,
        ];
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(harness.request).toHaveBeenCalledWith('preview.attach', expect.objectContaining({
            port: 8099,
            channel: expect.any(String),
            key: expect.any(String),
        }));

        // The sealed key the bridge serves with is the one the host dialed with.
        const attachedKey = (harness.request.mock.calls[0] as unknown[])[1] as { key: string };
        expect(harness.startBridge).toHaveBeenCalledTimes(1);
        expect((harness.startBridge.mock.calls[0] as unknown[])[1]).toBe(attachedKey.key);

        const socketUrl = FakeWebSocket.instances[0]!.url;
        expect(socketUrl).toContain('ticket=pwt-preview-test');
        expect(socketUrl).toContain('bridge=1');
        expect(socketUrl).not.toContain('devcred_test');
    });

    it('hands the takeover stream the same granted ticket', async () => {
        grant();
        const tunnel = await openBridged(8099, 'control', true);

        expect(tunnel.wsChannel).toBeDefined();
        expect(harness.request).toHaveBeenCalledWith('preview.attach', expect.objectContaining({
            port: 8099,
            mode: 'control',
        }));
        expect(String((harness.fetch.mock.calls[0] as unknown[])[0])).toBe(
            'https://grant-relay.example.ts.net/v1/ws-tickets',
        );
    });

    it('fails before attach when the hosted grant is missing', async () => {
        harness.bridgeAvailable = true;
        await expect(attachPreviewTunnel(8099)).rejects.toThrow('pair this browser again');
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.fetch).not.toHaveBeenCalled();
        expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it('fails before attach when the hosted grant expired', async () => {
        harness.bridgeAvailable = true;
        grant();
        harness.grant!.expiresAt = Date.now() - 1;
        await expect(attachPreviewTunnel(8099)).rejects.toThrow('pair this browser again');
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.fetch).not.toHaveBeenCalled();
    });

    it('still requires a real credential in local mode', async () => {
        harness.bridgeAvailable = false;
        harness.connection.mode = 'local';
        harness.connection.relayUrl = 'ws://127.0.0.1:8892';
        harness.connection.token = '';
        await expect(attachPreviewTunnel(8099, { rawTcp: true })).rejects.toThrow(
            'preview: relay ticket required',
        );
        expect(harness.request).not.toHaveBeenCalled();

        harness.connection.token = 'acctok_stale';
        await expect(attachPreviewTunnel(8099, { rawTcp: true })).rejects.toThrow(
            'preview: relay ticket required',
        );
        expect(harness.request).not.toHaveBeenCalled();
    });

    it('keeps the local token path unchanged', async () => {
        harness.connection.token = 'machtok_local';
        const tunnel = await openRawTcp();
        expect(tunnel.port).toBe(44123);
        expect(String((harness.fetch.mock.calls[0] as unknown[])[0])).toBe(
            'http://127.0.0.1:8892/v1/ws-tickets',
        );
    });
});
