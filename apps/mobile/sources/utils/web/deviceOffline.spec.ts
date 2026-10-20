import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The settings module pulls in React Native; the probe under test never reads it.
vi.mock('@/connection/connectionSettings', () => ({ getCachedConnectionSettings: () => ({ machineId: '', relayUrl: '' }) }));

import { relayAnswers } from './deviceOffline';

describe('relayAnswers', () => {
    let server: Server | undefined;
    afterEach(async () => {
        if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
    });

    it('answers while the relay listens and fails once it is gone', async () => {
        server = createServer((_req, res) => res.end('{"ok":true}'));
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        const relayUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
        expect(await relayAnswers(relayUrl)).toBe(true);

        await new Promise<void>((resolve) => server!.close(() => resolve()));
        expect(await relayAnswers(relayUrl)).toBe(false);
    });
});
