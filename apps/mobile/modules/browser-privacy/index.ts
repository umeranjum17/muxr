import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

interface BrowserPrivacyNative {
    setPrivate: (active: boolean) => boolean;
}

const native = Platform.OS === 'web' ? null : requireOptionalNativeModule<BrowserPrivacyNative>('BrowserPrivacy');

/**
 * App-switcher and screen-capture cover while the agent browser is private:
 * Android sets FLAG_SECURE on the window, iOS hides the window content behind
 * a secure text field layer. Best effort; the session logic never depends on
 * it, and a browser tab has no equivalent.
 */
export function setBrowserPrivate(active: boolean): boolean {
    try {
        return native?.setPrivate(active) ?? false;
    } catch {
        return false;
    }
}
