import { Platform } from 'react-native';

/**
 * What an install action can do right now, from real browser signals only.
 *
 * - `ready`       Chromium offered its install prompt and we are holding it, so
 *                 the row can hand it back to the person on tap.
 * - `ios-guide`   an iOS tab in any browser: there is no prompt API, so Add to
 *                 Home Screen is the only install path, and only Safari has it.
 * - `unavailable` installed, native, or a browser tab with no install path at
 *                 all; show nothing.
 */
export type WebInstallState = 'ready' | 'ios-guide' | 'unavailable';

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let started = false;
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
    // None of them can add a page to the Home Screen; only Safari can.
    return /CriOS|FxiOS|EdgiOS|OPiOS|OPR\/|SamsungBrowser/.test(ua) ? 'other' : 'safari';
}

/** True on an iOS tab that is not Safari, so the guide can say to open it there first. */
export function openedOutsideSafari(): boolean {
    return iosBrowser() === 'other';
}

function isStandalone(): boolean {
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
 * Idempotent, and a no-op on native and where the event never exists.
 */
export function startWebInstallCapture(): void {
    if (started || Platform.OS !== 'web' || typeof window === 'undefined') return;
    started = true;
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event as BeforeInstallPromptEvent;
        notify();
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        notify();
    });
}

/** Hand the held prompt back to the person. */
export async function promptWebInstall(): Promise<void> {
    const event = deferredPrompt;
    if (event === null) return;
    // A prompt is one-shot: drop it before showing it so a second tap cannot
    // call prompt() twice, which Chrome rejects.
    deferredPrompt = null;
    notify();
    try {
        await event.prompt();
    } catch {
        // The prompt is already dropped, so a rejected one has nothing to undo.
    }
}
