import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    platform: 'ios',
    isDevice: false,
    request: vi.fn(),
    startBridge: vi.fn(),
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
    getCachedConnectionSettings: () => ({ mode: 'local', relayUrl: 'ws://127.0.0.1:8892', machineId: 'sim', token: '' }),
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
    });

    it('uses the Mac loopback directly on the iOS simulator', async () => {
        const preview = await openPreview(8099);
        expect(preview.url).toBe('http://127.0.0.1:8099/');
        expect(preview.close()).toBeUndefined();
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.startBridge).not.toHaveBeenCalled();
    });
});
