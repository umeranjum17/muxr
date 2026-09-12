/**
 * What every surface frame (native WebView, web iframe) agrees on: the
 * navigation policy and the imperative controls the chrome may call.
 */

export type SurfaceFrameMode =
    | { kind: 'local'; origin: string }
    | { kind: 'direct' };

export interface SurfaceFrameHandle {
    reload(): void;
    goBack(): void;
    goForward(): void;
    stop(): void;
}

export interface SurfaceFrameProps {
    uri: string;
    mode: SurfaceFrameMode;
    /** A top-level navigation the policy refused. Never a silent drop. */
    onBlockedUrl?: (url: string) => void;
    /** Native scroll or touch on the page. Records interaction; no page script. */
    onInteract?: () => void;
    /** The renderer died; the owner tears down and recovers through fresh standing. */
    onRendererGone?: () => void;
    onNavigation?: (state: { canGoBack: boolean; canGoForward: boolean; url: string }) => void;
    onLoadStart?: () => void;
    onLoadEnd?: () => void;
    onError?: (description: string) => void;
}

export function allowsSurfaceNavigation(url: string, origin: string): boolean {
    return url === 'about:blank' || url === origin || url.startsWith(`${origin}/`);
}

function allowsDirectNavigation(url: string): boolean {
    if (url === 'about:blank') return true;
    if (url.length > 2048) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false;
        // On web the surface is a frame inside the PWA: framing the PWA's own
        // origin would hand a page that origin's storage and device grant.
        if (typeof window !== 'undefined' && typeof window.location?.origin === 'string' && parsed.origin === window.location.origin) return false;
        return true;
    } catch {
        return false;
    }
}

/** Credential-free HTTPS or the honest blank tab. Used by the address bar. */
export function isDirectUrl(url: string): boolean {
    return allowsDirectNavigation(url.trim());
}

export function surfaceNavigationAllowed(url: string, mode: SurfaceFrameMode): boolean {
    if (mode.kind === 'local') return allowsSurfaceNavigation(url, mode.origin);
    return allowsDirectNavigation(url);
}
