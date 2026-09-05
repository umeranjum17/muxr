import { Platform } from 'react-native';
import { getAppVersion } from '@/utils/appVersion';

/** Public client label attached to HTTP requests and diagnostics. */
export function getMuxrClientId(): string {
    let platform: string = Platform.OS;
    if (platform === 'web' && typeof window !== 'undefined' && '__TAURI__' in window) platform = 'desktop';
    return `${platform}/${getAppVersion()}`;
}
