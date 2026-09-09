import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { isTauri } from '@/utils/isTauri';

/**
 * Opens a URL in the system browser, not inside muxr. Chrome Custom Tabs
 * (createTask) still uses Chrome's download manager for APKs; Linking.openURL
 * alone can land in an in-app WebView that hangs on a 170MB download.
 */
export async function openExternalUrl(url: string): Promise<void> {
    if (Platform.OS === 'web') {
        if (isTauri()) {
            const { openUrl } = await import('@tauri-apps/plugin-opener');
            await openUrl(url);
        } else if (typeof window !== 'undefined') {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
    }

    if (/^https?:/i.test(url)) {
        try {
            await WebBrowser.openBrowserAsync(url, { createTask: true, showInRecents: true });
            return;
        } catch {
            // Fall through to Linking when Custom Tabs cannot start.
        }
    }
    await Linking.openURL(url);
}
