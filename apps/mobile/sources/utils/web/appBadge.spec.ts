import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAppBadge } from './appBadge';

describe('applyAppBadge', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows the needs-you count on the app icon', () => {
        const setAppBadge = vi.fn(async () => undefined);
        const clearAppBadge = vi.fn(async () => undefined);
        vi.stubGlobal('navigator', { setAppBadge, clearAppBadge });
        applyAppBadge(2);
        expect(setAppBadge).toHaveBeenCalledWith(2);
        expect(clearAppBadge).not.toHaveBeenCalled();
    });

    it('clears the app icon badge when nothing waits', () => {
        const setAppBadge = vi.fn(async () => undefined);
        const clearAppBadge = vi.fn(async () => undefined);
        vi.stubGlobal('navigator', { setAppBadge, clearAppBadge });
        applyAppBadge(0);
        expect(clearAppBadge).toHaveBeenCalledTimes(1);
        expect(setAppBadge).not.toHaveBeenCalled();
    });

    it('is a silent no-op where the Badging API is missing', () => {
        // A plain tab or an older browser has no navigator at all, or no
        // setAppBadge; neither may throw or touch an absent method.
        vi.stubGlobal('navigator', {});
        expect(() => applyAppBadge(2)).not.toThrow();
        vi.stubGlobal('navigator', undefined);
        expect(() => applyAppBadge(2)).not.toThrow();
    });
});
