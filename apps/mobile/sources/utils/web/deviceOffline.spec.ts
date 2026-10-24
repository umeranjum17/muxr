import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The settings module pulls in React Native; the probe under test never reads it.
vi.mock('@/connection/connectionSettings', () => ({ getCachedConnectionSettings: () => ({ machineId: '', relayUrl: '' }) }));

import { reachVerdict } from './deviceOffline';

describe('reachVerdict', () => {
    const servers: Server[] = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => server.listening && new Promise<void>((resolve) => server.close(() => resolve()))));
    });

    async function listen(): Promise<{ server: Server; port: number }> {
        const server = createServer((_req, res) => res.end('ok'));
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        return { server, port: (server.address() as AddressInfo).port };
    }

    it('blames the device network only when the internet fails too', async () => {
        const relay = await listen();
        const internet = await listen();
        const relayUrl = `ws://127.0.0.1:${relay.port}`;
        const internetUrls = [`http://127.0.0.1:${internet.port}/generate_204`];
        expect(await reachVerdict(relayUrl, internetUrls)).toBe('reachable');

        // Tailscale off or the computer asleep: the phone is online, the relay is gone.
        await new Promise<void>((resolve) => relay.server.close(() => resolve()));
        expect(await reachVerdict(relayUrl, internetUrls)).toBe('unreachable');

        await new Promise<void>((resolve) => internet.server.close(() => resolve()));
        expect(await reachVerdict(relayUrl, internetUrls)).toBe('offline');
    });
});
