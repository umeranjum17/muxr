/**
 * Mirror the "needs you" count onto the installed PWA's app icon.
 *
 * The Badging API is the web twin of the native icon badge: `setAppBadge(n)`
 * shows the count, `clearAppBadge()` removes it. A plain tab, an older browser,
 * or a desktop with no badge surface simply lacks the API, so a missing one is
 * a silent no-op and never an error. Native owns its own icon badge.
 */
export function applyAppBadge(count: number): void {
    if (typeof navigator === 'undefined') return;
    const badge = navigator as Navigator & {
        setAppBadge?: (contents?: number) => Promise<void>;
        clearAppBadge: () => Promise<void>;
    };
    if (typeof badge.setAppBadge !== 'function') return;
    const result = count > 0 ? badge.setAppBadge(count) : badge.clearAppBadge();
    void Promise.resolve(result).catch(() => undefined);
}
