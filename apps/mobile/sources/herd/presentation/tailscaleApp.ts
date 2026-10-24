import { Linking, Platform } from 'react-native';
import { Modal } from '@/modal';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { openTailscaleApp } from '@/../modules/tailnet-address';

const PLAY_STORE_APP = 'market://details?id=com.tailscale.ipn';
const PLAY_STORE_WEB = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';
const APP_STORE = 'https://apps.apple.com/app/id1470499037';
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';

export async function openTailscaleStore(): Promise<void> {
    try {
        if (Platform.OS === 'web') return await openExternalUrl(TAILSCALE_DOWNLOAD);
        if (Platform.OS === 'ios') return await Linking.openURL(APP_STORE);
        // A device without the Play Store app has no market: handler; its web page still installs.
        await Linking.openURL(PLAY_STORE_APP).catch(() => openExternalUrl(PLAY_STORE_WEB));
    } catch (error) {
        Modal.alert('Could not open the store', `${error instanceof Error ? error.message : String(error)}\nSearch for Tailscale in your app store.`);
    }
}

/** Opens Tailscale where Android can launch it, else its store page, which
 *  offers Open once it is installed. */
export async function openTailscale(): Promise<void> {
    if (!openTailscaleApp()) await openTailscaleStore();
}
