/**
 * Demo route guard. Synchronous and dependency-free so the root layout can
 * select the demo runtime before any credential restore, sync, push, or
 * plugin effect mounts. Native-safe: no window access unless present.
 */
export function isDemoPathname(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return window.location.pathname === '/demo' || window.location.pathname.startsWith('/demo/');
    } catch {
        return false;
    }
}
