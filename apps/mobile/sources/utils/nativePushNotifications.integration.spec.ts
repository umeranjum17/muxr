import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({
    token: 'ExpoPushToken[device]' as string | null,
    clear: vi.fn(),
    client: { registerPush: vi.fn(), unregisterPush: vi.fn() },
}));

vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/connection/sessionClientRef', () => ({ activeSessionClient: () => persistence.client }));
vi.mock('@/catalog/application/persistence', () => ({
    clearRegisteredPushToken: () => { persistence.token = null; persistence.clear(); },
    loadRegisteredPushToken: () => persistence.token,
    saveRegisteredPushToken: (token: string) => { persistence.token = token; },
}));
vi.mock('@/utils/microphonePermissions', () => ({ requestNotificationPermission: async () => true }));
vi.mock('@/catalog/store', () => ({
    storage: { getState: () => ({ localSettings: { lifecycleNotificationLevel: 'important' } }) },
}));

import { unregisterNativePushNotifications, updateNativePushNotificationLevel } from './nativePushNotifications';

describe('native lifecycle push registration over the session', () => {
    beforeEach(() => {
        persistence.token = 'ExpoPushToken[device]';
        persistence.clear.mockClear();
        persistence.client.registerPush.mockReset();
        persistence.client.unregisterPush.mockReset().mockResolvedValue(true);
    });

    it('serializes level changes and removes the link registration on logout', async () => {
        const mutations: string[] = [];
        let release!: (value: boolean) => void;
        persistence.client.registerPush.mockImplementationOnce((_token: string, level: string) => {
            mutations.push(level);
            return new Promise<boolean>((resolve) => { release = resolve; });
        }).mockImplementation(async (_token: string, level: string) => { mutations.push(level); return true; });
        persistence.client.unregisterPush.mockImplementation(async () => { mutations.push('logout'); return true; });

        const off = updateNativePushNotificationLevel('off');
        await vi.waitFor(() => expect(mutations).toEqual(['off']));
        const important = updateNativePushNotificationLevel('important');
        const all = updateNativePushNotificationLevel('all');
        release(true);
        await expect(Promise.all([off, important, all])).resolves.toEqual([true, true, true]);
        expect(mutations).toEqual(['off', 'all']);

        mutations.length = 0;
        const post = updateNativePushNotificationLevel('important');
        await vi.waitFor(() => expect(mutations).toEqual(['important']));
        const logout = unregisterNativePushNotifications({ token: 'device-credential' } as never);
        const lateUpdate = updateNativePushNotificationLevel('all');
        await expect(post).resolves.toBe(true);
        await logout;
        await expect(lateUpdate).resolves.toBe(false);
        expect(mutations).toEqual(['important', 'logout']);
        expect(persistence.clear).toHaveBeenCalledOnce();
    });
});
