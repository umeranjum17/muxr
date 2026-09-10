import { Platform } from 'react-native';

/**
 * PWA install helpers (web only). Authority is never inferred from these:
 * installed display-mode does not change the grant, the TTL, or the device
 * kind — pairing still mints an explicit browser grant.
 */

export function isWebPlatform(): boolean {
    return Platform.OS === 'web';
}

/** True on iPhone/iPad web views, where Home Screen apps get isolated storage. */
export function isIOSBrowser(): boolean {
    if (!isWebPlatform() || typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent ?? '';
    return /iPad|iPhone|iPod/.test(ua)
        || (typeof navigator.platform === 'string' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * True when running inside the installed app (standalone display-mode or iOS
 * legacy standalone). Used only to pick install UX ordering — never authority.
 */
export function isStandaloneDisplay(): boolean {
    if (!isWebPlatform() || typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function'
        && window.matchMedia('(display-mode: standalone)').matches) return true;
    return (navigator as { standalone?: boolean }).standalone === true;
}

type InstallPromptEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
};

let deferredPrompt: InstallPromptEvent | undefined;

/** Call once from the web layout effect; captures beforeinstallprompt. */
export function watchInstallPrompt(): void {
    if (!isWebPlatform() || typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event as InstallPromptEvent;
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = undefined;
    });
}

export function canPromptInstall(): boolean {
    return deferredPrompt !== undefined;
}

/** Shows the browser install prompt. Resolves true when accepted. */
export async function promptInstall(): Promise<boolean> {
    const prompt = deferredPrompt;
    if (!prompt) return false;
    deferredPrompt = undefined;
    try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        return choice?.outcome === 'accepted';
    } catch {
        return false;
    }
}
