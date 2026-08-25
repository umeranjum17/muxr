import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    platform: 'ios',
    isDevice: false,
    request: vi.fn(),
    startBridge: vi.fn(),
    connection: {
        mode: 'local' as 'local' | 'hosted',
        relayUrl: 'ws://127.0.0.1:8892',
        machineId: 'sim',
        token: '',
    },
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() { return harness.platform; },
    },
}));
vi.mock('expo-device', () => ({
    get isDevice() { return harness.isDevice; },
}));
vi.mock('@/state/connectionSettings', () => ({
    getCachedConnectionSettings: () => harness.connection,
}));
vi.mock('@/sync/sync', () => ({ sync: { request: harness.request } }));
vi.mock('./previewBridge', () => ({
    previewBridgeAvailable: true,
    startPreviewBridge: harness.startBridge,
}));

import { openPreview } from './openPreview';

describe('openPreview', () => {
    beforeEach(() => {
        harness.platform = 'ios';
        harness.isDevice = false;
        harness.request.mockReset();
        harness.startBridge.mockReset();
        harness.connection.mode = 'local';
        harness.connection.relayUrl = 'ws://127.0.0.1:8892';
        harness.connection.machineId = 'sim';
        harness.connection.token = '';
    });

    it('uses the Mac loopback directly on the iOS simulator', async () => {
        const preview = await openPreview(8099);
        expect(preview.url).toBe('http://127.0.0.1:8099/');
        expect(preview.close()).toBeUndefined();
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.startBridge).not.toHaveBeenCalled();
    });

    it('rejects a remote paired machine on the iOS simulator', async () => {
        harness.connection.mode = 'hosted';
        harness.connection.relayUrl = 'wss://remote-machine.tailnet.ts.net';
        harness.connection.machineId = 'remote';

        await expect(openPreview(8099)).rejects.toThrow(
            'Preview from a remote machine is unavailable in the iOS Simulator.',
        );
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.startBridge).not.toHaveBeenCalled();
    });
});
