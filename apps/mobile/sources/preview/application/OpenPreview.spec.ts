import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    request: vi.fn(),
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

import { openPreview } from './OpenPreview';

describe('openPreview', () => {
    beforeEach(() => {
        harness.request.mockReset();
        harness.connection.mode = 'local';
        harness.connection.relayUrl = 'ws://127.0.0.1:8892';
        harness.connection.machineId = 'sim';
        harness.connection.token = '';
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
