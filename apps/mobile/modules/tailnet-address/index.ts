import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

interface TailnetAddressNative {
    present: () => boolean;
}

const native = Platform.OS === 'android'
    ? requireOptionalNativeModule<TailnetAddressNative>('TailnetAddress')
    : null;

/**
 * Whether this device holds a Tailscale address, so Tailscale is on and signed
 * in here. undefined where it cannot be read: iOS and the web.
 * ponytail: Android only; iOS needs getifaddrs on a utun interface.
 */
export function hasTailnetAddress(): boolean | undefined {
    try {
        return native?.present();
    } catch {
        return undefined;
    }
}
