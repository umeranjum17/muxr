import { Platform } from 'react-native';
import { loadAppConfig } from '@/catalog';
import { setupEmptyState } from '@/commercialization';

/**
 * The desktop app's download link, or undefined where Add your computer cannot
 * finish: a build with no public site has no link, and a browser cannot pair
 * with the desktop app, which offers only phone (native) codes.
 */
export function addComputerLink(): string | undefined {
    if (Platform.OS === 'web') return undefined;
    return setupEmptyState(loadAppConfig().publicBaseUrl).desktopUrl;
}
