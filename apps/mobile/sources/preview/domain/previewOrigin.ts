/**
 * Where a preview document may be shown.
 *
 * A same-origin bridge URL (`/muxr-preview/<channel>/` served by the
 * service worker) runs page JavaScript in the PWA's own origin, where the
 * device credential and its wrapping key live. It is safe only inside an
 * opaque-sandboxed iframe: opened top-level it would be first-party code
 * with access to that storage. Independently isolated origins (relay-port
 * previews) carry no such risk and may open in a tab.
 */
export function previewIsSameOrigin(url: string, pageHref: string): boolean {
    try {
        return new URL(url, pageHref).origin === new URL(pageHref).origin;
    } catch {
        return false;
    }
}

export function previewMayOpenTopLevel(url: string, pageHref: string): boolean {
    return !previewIsSameOrigin(url, pageHref);
}
