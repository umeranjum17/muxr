import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hosted regression: connection settings carry no usable token in hosted and
 * self-host mode (the ticket credential lives on the grant). The preview
 * tunnel used to throw `preview: relay ticket required` for every paired
 * user, so the browser Watch live page never rendered.
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
    fetch: vi.fn(),
    startPreviewBridge: vi.fn(),
}));

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => ({
        mode: 'hosted',
        relayUrl: 'ws://relay.test',
        machineId: 'machine',
        token: '',
    }),
}));

vi.mock('@/catalog/sync', () => ({
    sync: { request: mocks.request },
}));

vi.mock('@/pairing/e2ee', () => ({
    getCachedHostedGrant: () => grant,
}));

vi.mock('./previewBridge', () => ({
    previewBridgeAvailable: true,
    startPreviewBridge: mocks.startPreviewBridge,
}));

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static instances: FakeWebSocket[] = [];

    binaryType = 'blob';
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('fetch', mocks.fetch);

import { attachPreviewTunnel } from './attachPreviewTunnel';

describe('attachPreviewTunnel hosted transport', () => {
    beforeEach(() => {
        grant.expiresAt = Date.now() + 60_000;
        mocks.request.mockReset().mockResolvedValue({});
        mocks.fetch.mockReset().mockResolvedValue({
            ok: true,
            status: 201,
            json: async () => ({ ticket: 'pwt-test', expires_in: 60 }),
        });
        mocks.startPreviewBridge.mockReset().mockResolvedValue({ port: 41234, close: vi.fn() });
        FakeWebSocket.instances.length = 0;
    });

    it('issues the ticket under the grant credential at the grant relay, then bridges the stream', async () => {
        const opening = attachPreviewTunnel(18912);
        await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));

        expect(mocks.request).toHaveBeenCalledWith('preview.attach', expect.objectContaining({ port: 18912 }));
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        const [ticketUrl, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
        expect(ticketUrl).toBe('https://hosted.relay.test/v1/ws-tickets');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer pck_device_cred');
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ machineSlug: 'machine', role: 'client', transport: 'preview' });

        const socket = FakeWebSocket.instances[0]!;
        expect(socket.url).toBe('wss://hosted.relay.test/preview?ticket=pwt-test&bridge=1');
        socket.onmessage?.({ data: JSON.stringify({ type: 'preview.bridge' }) });
        const tunnel = await opening;
        expect(tunnel.port).toBe(41234);
        expect(tunnel.hostname).toBe('127.0.0.1');
    });

    it('rejects an expired grant before attaching anything on the host', async () => {
        grant.expiresAt = Date.now() - 1_000;
        await expect(attachPreviewTunnel(18912)).rejects.toThrow('device grant expired; pair again');
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(FakeWebSocket.instances.length).toBe(0);
    });
});
