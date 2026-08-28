import { Platform } from 'react-native';
import Constants from 'expo-constants';

/** Public client label attached to HTTP requests and diagnostics. */
export function getMuxrClientId(): string {
    let platform: string = Platform.OS;
    if (platform === 'web' && typeof window !== 'undefined' && '__TAURI__' in window) platform = 'desktop';
    return `${platform}/${Constants.expoConfig?.version || '0.0.0'}`;
}
