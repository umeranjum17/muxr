import { Platform } from 'react-native';

/**
 * What an install action can do right now, from real browser signals only.
 *
 * - `ready`       Chromium offered its install prompt and we are holding it, so
 *                 the row can hand it back to the person on tap.
 * - `ios-guide`   an iOS tab in any browser: there is no prompt API, so Add to
 *                 Home Screen is the only install path, and only Safari has it.
 * - `browser-menu` the person dismissed Chromium's prompt. The saved prompt
 *                 cannot be shown again, so the row points at the browser menu.
 * - `unavailable` installed, native, or a browser tab with no install path at
 *                 all; show nothing.
 */
export type WebInstallState = 'ready' | 'ios-guide' | 'browser-menu' | 'unavailable';

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let promptDismissed = false;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

function iosBrowser(): 'safari' | 'other' | null {
    if (typeof navigator === 'undefined') return null;
    const ua = navigator.userAgent ?? '';
    // iPadOS 13+ reports a desktop "MacIntel" user agent with touch points.
    const iPad = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1;
    if (!(iPad || /iPhone|iPad|iPod/.test(ua))) return null;
    // Chrome, Firefox, Edge, Opera and Samsung on iOS all wear a WebKit UA.
    // None of them can add a page to the Home Screen; only Safari can. An
    // in-app web view has no Safari token at all, so it is not Safari either.
    return /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPR\/|SamsungBrowser/.test(ua) ? 'safari' : 'other';
}

/** True on an iOS tab that is not Safari, so the guide can say to open it there first. */
export function openedOutsideSafari(): boolean {
    return iosBrowser() === 'other';
}

/** True when the page runs as an installed app (display-mode or iOS navigator.standalone). */
export function isStandalone(): boolean {
    if (typeof navigator !== 'undefined' && (navigator as { standalone?: boolean }).standalone === true) return true;
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(display-mode: standalone)').matches;
}

/** The single snapshot the install row renders from. */
export function getWebInstallState(): WebInstallState {
    if (Platform.OS !== 'web' || isStandalone()) return 'unavailable';
    // iOS has no prompt API at all, so Add to Home Screen is always the path
    // there — even if a stray installability event ever reached the page.
    if (iosBrowser() !== null) return 'ios-guide';
    if (deferredPrompt !== null) return 'ready';
    if (promptDismissed) return 'browser-menu';
    return 'unavailable';
}

/** Subscribe the install row to prompt/installed changes. */
export function subscribeWebInstall(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * Hold the browser's install prompt from app start. Chromium fires
 * `beforeinstallprompt` once and never hands it back, so it must be caught
 * before Settings could open; the row then returns the held prompt on tap.
 * A no-op on native and where the event never exists.
 */
export function startWebInstallCapture(): void {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event as BeforeInstallPromptEvent;
        notify();
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        promptDismissed = false;
        notify();
    });
}

/**
 * Hand the held prompt back to the person. The row stays until the outcome is
 * known: an accepted install hides it, a dismissal swaps it for a browser-menu
 * line, since the prompt is one-shot and Chrome will not re-issue it this load.
 */
export async function promptWebInstall(): Promise<void> {
    const event = deferredPrompt;
    if (event === null) return;
    let outcome: 'accepted' | 'dismissed' = 'dismissed';
    try {
        await event.prompt();
        outcome = (await event.userChoice).outcome;
    } catch {
        // A prompt that never showed leaves the browser menu as the only path.
    }
    deferredPrompt = null;
    promptDismissed = outcome === 'dismissed';
    notify();
}
