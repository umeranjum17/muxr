import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MuxrClient } from '../../../apps/mobile/sources/pairing/infrastructure/muxrClient.js';
import { startRelay, type RelayHandle } from '../../../apps/relay/src/relay.js';
import { createFakeSessionSource } from '../../../apps/host/src/agent/index.js';
import { startHost, type Host } from '../../../apps/host/src/host.js';

const hostedMocks = vi.hoisted(() => ({
    refreshHostedGrant: vi.fn(async () => undefined as never),
}));

vi.mock('../../../apps/mobile/sources/pairing/application/hostedE2ee.js', () => ({
    refreshHostedGrant: hostedMocks.refreshHostedGrant,
    DeviceV2Crypto: class {
        constructor(readonly grant: unknown) {}
    },
}));

const delay = (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
};

const waitForState = (client: MuxrClient, expected: typeof client.state): Promise<void> => {
    if (client.state === expected) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const off = client.onStateChange((state) => {
        if (state !== expected) return;
        off();
        resolve();
    });
    return promise;
};

describe('connection stability under agent load', () => {
    let relay: RelayHandle | undefined;
    let host: Host | undefined;
    let client: MuxrClient | undefined;
    let dataDir: string | undefined;

    afterEach(async () => {
        client?.close();
        await host?.close();
        await relay?.close();
        if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
        vi.unstubAllGlobals();
        hostedMocks.refreshHostedGrant.mockReset();
        hostedMocks.refreshHostedGrant.mockResolvedValue(undefined as never);
    });

    it('keeps reconnect truth and sync healthy with five active agents', async () => {
        vi.stubGlobal('WebSocket', WebSocket);
        dataDir = await mkdtemp(join(tmpdir(), 'muxr-connection-load-'));
        relay = await startRelay({
            port: 0,
            host: '127.0.0.1',
            config: {
                dataDir,
                authMode: 'permissive',
                e2eeMode: 'off',
                localAuthority: false,
                developmentApi: true,
                advertiseMdns: false,
            },
        });
        const port = relay.port;
        const source = createFakeSessionSource();
        for (let index = 0; index < 5; index += 1) await source.start({ cwd: dataDir });
        const list = source.list.bind(source);
        source.list = async (options) => {
            // Real clock delay reproduces the measured host snapshot latency;
            // fake timers cannot drive ws and the HTTP server event loops.
            await delay(105);
            return list(options);
        };
        const hostOpened = Promise.withResolvers<void>();
        host = startHost({
            relayUrl: `ws://127.0.0.1:${port}`,
            machineId: 'load-machine',
            source,
            domain: { unread: { acknowledge: () => undefined, noteActivity: () => undefined } } as never,
            onStateChange: (state) => {
                if (state === 'open') hostOpened.resolve();
            },
        });
        await hostOpened.promise;

        client = new MuxrClient({
            mode: 'local',
            relayUrl: `ws://127.0.0.1:${port}`,
            machineId: 'load-machine',
            requestTimeoutMs: 500,
            reconnectDelayMs: 20,
        });
        const states: string[] = [];
        client.onStateChange((state) => states.push(state));
        const initiallyOpened = waitForState(client, 'open');
        client.connect();
        await initiallyOpened;

        const interrupted = client.request('session.list', {}).catch((error: unknown) => error);
        const clientClosed = waitForState(client, 'closed');
        await relay.close();
        await clientClosed;
        const clientReopened = waitForState(client, 'open');
        relay = await startRelay({
            port,
            host: '127.0.0.1',
            config: {
                dataDir,
                authMode: 'permissive',
                e2eeMode: 'off',
                localAuthority: false,
                developmentApi: true,
                advertiseMdns: false,
            },
        });
        const reconnectStart = states.length;
        await clientReopened;
        await interrupted;
        expect(states.slice(reconnectStart)).not.toContain('stale');

        const catalogs = await Promise.all(Array.from({ length: 5 }, () => client!.request('session.list', {})));
        expect(catalogs.every((sessions) => sessions.length === 5)).toBe(true);

        // A path change can leave the phone's old TCP socket looking OPEN even
        // though the machine route is gone. One unanswered request must retire
        // that socket before the host returns.
        await host.close();
        host = undefined;
        const routeLostAt = states.length;
        const stale = waitForState(client, 'stale');
        const disconnected = waitForState(client, 'closed');
        const reconnecting = waitForState(client, 'connecting');
        const lostRequest = client.request('session.list', {}).catch((error: unknown) => error);
        await stale;
        await disconnected;
        await reconnecting;
        const lostStates = states.slice(routeLostAt);
        expect(lostStates.indexOf('stale')).toBeLessThan(lostStates.indexOf('closed'));
        expect(lostStates.indexOf('closed')).toBeLessThan(lostStates.indexOf('connecting'));

        const recoveredSource = createFakeSessionSource();
        for (let index = 0; index < 5; index += 1) await recoveredSource.start({ cwd: dataDir });
        const recoveredHost = Promise.withResolvers<void>();
        const recoveredClient = waitForState(client, 'open');
        host = startHost({
            relayUrl: `ws://127.0.0.1:${port}`,
            machineId: 'load-machine',
            source: recoveredSource,
            domain: { unread: { acknowledge: () => undefined, noteActivity: () => undefined } } as never,
            onStateChange: (state) => {
                if (state === 'open') recoveredHost.resolve();
            },
        });
        await recoveredHost.promise;
        await recoveredClient;
        await lostRequest;
        await expect(client.request('session.list', {})).resolves.toHaveLength(5);

        // The relay's first server-driven ping is at 30s. Sync after that proves
        // the real client-host-relay socket stayed responsive through keepalive.
        await delay(30_500);
        await expect(client.request('session.list', {})).resolves.toHaveLength(5);
        expect(client.state).toBe('open');
    }, 40_000);

    it('keeps explicit close final while ticket or grant acquisition is in flight', async () => {
        let socketCreations = 0;
        class CountingWebSocket {
            static readonly CONNECTING = 0;
            static readonly OPEN = 1;
            readyState = CountingWebSocket.CONNECTING;
            onopen: (() => void) | null = null;
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: (() => void) | null = null;
            onclose: (() => void) | null = null;
            constructor(_url: string) { socketCreations += 1; }
            send(): void {}
            close(): void { this.onclose?.(); }
        }
        vi.stubGlobal('WebSocket', CountingWebSocket);

        const ticketStarted = Promise.withResolvers<void>();
        const ticketResponse = Promise.withResolvers<Response>();
        vi.stubGlobal('fetch', vi.fn(() => {
            ticketStarted.resolve();
            return ticketResponse.promise;
        }));
        client = new MuxrClient({
            mode: 'local',
            relayUrl: 'wss://relay.test',
            machineId: 'close-boundary',
            token: 'ticket-credential',
        });
        const states: string[] = [];
        client.onStateChange((state) => states.push(state));
        client.connect();
        await ticketStarted.promise;
        client.close();
        const closedStateCount = states.length;
        ticketResponse.resolve(new Response(JSON.stringify({ ticket: 'ticket' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        await delay(0);
        expect(socketCreations).toBe(0);
        expect(client.state).toBe('closed');
        expect(states).toHaveLength(closedStateCount);

        const grantStarted = Promise.withResolvers<void>();
        const grantResponse = Promise.withResolvers<never>();
        hostedMocks.refreshHostedGrant.mockImplementationOnce(() => {
            grantStarted.resolve();
            return grantResponse.promise;
        });
        const permanentError = vi.fn();
        client = new MuxrClient({
            mode: 'hosted',
            relayUrl: 'wss://relay.test',
            machineId: 'close-boundary',
            token: 'grant-credential',
            hostedGrant: {} as never,
            onPermanentError: permanentError,
        });
        client.connect();
        await grantStarted.promise;
        client.close();
        grantResponse.reject(new Error('hosted device grant expired'));
        await delay(0);
        expect(permanentError).not.toHaveBeenCalled();
        expect(client.state).toBe('closed');
        expect(socketCreations).toBe(0);
    });
});
