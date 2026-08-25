import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const SIMULATOR_PREFIX = 'muxr.simulator-secure.v1:';

/**
 * Simulator binaries can be ad-hoc signed without a keychain entitlement.
 * Keep that development-only case usable without weakening physical devices.
 */
export function usesSimulatorSecretStore(): boolean {
    return Platform.OS === 'ios' && Device.isDevice === false;
}

function simulatorKey(key: string): string {
    return `${SIMULATOR_PREFIX}${key}`;
}

export function getNativeSecret(key: string): Promise<string | null> {
    return usesSimulatorSecretStore()
        ? AsyncStorage.getItem(simulatorKey(key))
        : SecureStore.getItemAsync(key);
}

export async function setNativeSecret(key: string, value: string): Promise<void> {
    if (usesSimulatorSecretStore()) {
        await AsyncStorage.setItem(simulatorKey(key), value);
        return;
    }
    await SecureStore.setItemAsync(key, value);
}

export async function deleteNativeSecret(key: string): Promise<void> {
    if (usesSimulatorSecretStore()) {
        await AsyncStorage.removeItem(simulatorKey(key));
        return;
    }
    await SecureStore.deleteItemAsync(key);
}
