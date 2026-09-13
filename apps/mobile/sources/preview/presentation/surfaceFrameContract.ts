/**
 * What every surface frame (native WebView, web iframe) agrees on: the
 * navigation policy and the imperative controls the chrome may call.
 */

/** One-use admission the frame posts to `origin + path` exactly once. */
export interface PreviewBootstrap {
    path: string;
    body: string;
}

export type SurfaceFrameMode =
    /**
     * A leased app on its host-allocated HTTPS origin. The first navigation is
     * the bootstrap POST; the gateway answers a `__Host-` cookie and redirects
     * to `uri`. Everything after is ordinary navigation inside `origin`.
     */
    | { kind: 'local'; origin: string; bootstrap: PreviewBootstrap }
    | { kind: 'direct' };

export interface SurfaceFrameHandle {
    /** Re-navigate to `uri`. A recovery action, never the update mechanism. */
    reload(): void;
    goBack(): void;
    goForward(): void;
    stop(): void;
    /**
     * Local mode: post a fresh bootstrap through a hidden auxiliary frame that
     * shares the preview origin's cookie store, so the healthy main document
     * keeps running and its framework reconnects on its own. Resolves once
     * the auxiliary frame has landed.
     */
    readmit(bootstrap: PreviewBootstrap): Promise<void>;
}

export interface SurfaceFrameProps {
    /** The app URL: `origin + path` in local mode, the page itself in direct mode. */
    uri: string;
    mode: SurfaceFrameMode;
    /** Local mode, native only: the gateway refused the main document (admission cookie gone). */
    onAdmissionRefused?: () => void;
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
