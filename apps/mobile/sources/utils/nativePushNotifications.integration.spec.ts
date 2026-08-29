import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({
    token: 'ExpoPushToken[device]' as string | null,
    clear: vi.fn(),
}));

vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/account', () => ({
    TokenStorage: { getCredentials: async () => ({ token: 'device-credential' }) },
}));
vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => ({ relayUrl: 'wss://relay.test' }),
}));
vi.mock('@/catalog/application/persistence', () => ({
    clearRegisteredPushToken: () => {
        persistence.token = null;
        persistence.clear();
    },
    loadRegisteredPushToken: () => persistence.token,
    saveRegisteredPushToken: (token: string) => { persistence.token = token; },
}));
vi.mock('@/utils/microphonePermissions', () => ({ requestNotificationPermission: async () => true }));
vi.mock('@/catalog/store', () => ({
    storage: { getState: () => ({ localSettings: { lifecycleNotificationLevel: 'important' } }) },
}));

import { unregisterNativePushNotifications, updateNativePushNotificationLevel } from './nativePushNotifications';

const originalFetch = globalThis.fetch;

describe('native lifecycle notification registration flow', () => {
    beforeEach(() => {
        persistence.token = 'ExpoPushToken[device]';
        persistence.clear.mockClear();
    });
    afterEach(() => vi.stubGlobal('fetch', originalFetch));

    it('keeps the latest level and makes logout the final relay mutation', async () => {
        const mutations: Array<{ method: string; level?: string }> = [];
        let deferNextPost = true;
        let releasePost!: (response: Response) => void;
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const body = JSON.parse(String(init?.body)) as { level?: string };
            mutations.push({ method, ...(body.level === undefined ? {} : { level: body.level }) });
            if (method === 'POST' && deferNextPost) {
                deferNextPost = false;
                return await new Promise<Response>((resolve) => { releasePost = resolve; });
            }
            return new Response(null, { status: 200 });
        }));

        const off = updateNativePushNotificationLevel('off');
        await vi.waitFor(() => expect(mutations).toEqual([{ method: 'POST', level: 'off' }]));
        const important = updateNativePushNotificationLevel('important');
        const all = updateNativePushNotificationLevel('all');
        releasePost(new Response(null, { status: 200 }));
        await expect(Promise.all([off, important, all])).resolves.toEqual([true, true, true]);
        expect(mutations).toEqual([
            { method: 'POST', level: 'off' },
            { method: 'POST', level: 'all' },
        ]);

        mutations.length = 0;
        deferNextPost = true;
        const post = updateNativePushNotificationLevel('important');
        await vi.waitFor(() => expect(mutations).toEqual([{ method: 'POST', level: 'important' }]));
        const logout = unregisterNativePushNotifications({ token: 'device-credential' } as never);
        const lateUpdate = updateNativePushNotificationLevel('all');
        expect(mutations).toEqual([{ method: 'POST', level: 'important' }]);

        releasePost(new Response(null, { status: 200 }));
        await expect(post).resolves.toBe(true);
        await logout;
        await expect(lateUpdate).resolves.toBe(false);
        expect(mutations).toEqual([
            { method: 'POST', level: 'important' },
            { method: 'DELETE' },
        ]);
        expect(persistence.clear).toHaveBeenCalledOnce();
    });
});
