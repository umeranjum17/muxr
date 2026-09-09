import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    platform: 'ios',
    isDevice: false,
    asyncValues: new Map<string, string>(),
    secureValues: new Map<string, string>(),
    secureGet: vi.fn<(key: string) => Promise<string | null>>(),
    secureSet: vi.fn<(key: string, value: string) => Promise<void>>(),
    secureDelete: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() { return harness.platform; },
    },
}));
vi.mock('expo-device', () => ({
    get isDevice() { return harness.isDevice; },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: harness.secureGet,
    setItemAsync: harness.secureSet,
    deleteItemAsync: harness.secureDelete,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => harness.asyncValues.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { harness.asyncValues.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { harness.asyncValues.delete(key); }),
    },
}));

import {
    deleteNativeSecret,
    getNativeSecret,
    setNativeSecret,
    usesSimulatorSecretStore,
} from './nativeSecretStore';

describe('native secret storage', () => {
    beforeEach(() => {
        harness.platform = 'ios';
        harness.isDevice = false;
        harness.asyncValues.clear();
        harness.secureValues.clear();
        harness.secureGet.mockReset().mockImplementation(async (key) => harness.secureValues.get(key) ?? null);
        harness.secureSet.mockReset().mockImplementation(async (key, value) => { harness.secureValues.set(key, value); });
        harness.secureDelete.mockReset().mockImplementation(async (key) => { harness.secureValues.delete(key); });
    });

    it('uses namespaced AsyncStorage only for the iOS simulator', async () => {
        expect(usesSimulatorSecretStore()).toBe(true);
        await setNativeSecret('grant', 'sealed');
        expect(await getNativeSecret('grant')).toBe('sealed');
        expect([...harness.asyncValues]).toEqual([['muxr.simulator-secure.v1:grant', 'sealed']]);
        expect(harness.secureSet).not.toHaveBeenCalled();

        await deleteNativeSecret('grant');
        expect(await getNativeSecret('grant')).toBeNull();
    });

    it('keeps physical iOS devices on SecureStore', async () => {
        harness.isDevice = true;
        expect(usesSimulatorSecretStore()).toBe(false);
        await setNativeSecret('grant', 'sealed');
        expect(await getNativeSecret('grant')).toBe('sealed');
        expect(harness.secureSet).toHaveBeenCalledWith('grant', 'sealed');
        expect(harness.asyncValues.size).toBe(0);
    });

    it('does not weaken Android emulators', async () => {
        harness.platform = 'android';
        expect(usesSimulatorSecretStore()).toBe(false);
        await setNativeSecret('grant', 'sealed');
        expect(harness.secureSet).toHaveBeenCalledWith('grant', 'sealed');
    });
});
