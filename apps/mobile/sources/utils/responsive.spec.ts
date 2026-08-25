import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Dimensions: { get: () => ({ width: 1024, height: 1366 }) },
    Platform: { OS: 'ios', isPad: true },
    useWindowDimensions: () => ({ width: 1024, height: 1366 }),
}));
vi.mock('./platform', () => ({ isRunningOnMac: () => false }));

import { shouldUseSplitViewLayout, sidebarWidth, SPLIT_VIEW_MIN_WIDTH } from './responsive';

describe('shouldUseSplitViewLayout', () => {
    it('uses master-detail on a full-width iPad but not a narrow Stage Manager window', () => {
        expect(shouldUseSplitViewLayout({
            width: 1024,
            platform: 'ios',
            isPad: true,
            isMac: false,
            deviceType: 'tablet',
        })).toBe(true);
        expect(shouldUseSplitViewLayout({
            width: SPLIT_VIEW_MIN_WIDTH - 1,
            platform: 'ios',
            isPad: true,
            isMac: false,
            deviceType: 'tablet',
        })).toBe(false);
    });

    it('keeps an iPhone landscape window single-pane', () => {
        expect(shouldUseSplitViewLayout({
            width: 932,
            platform: 'ios',
            isPad: false,
            isMac: false,
            deviceType: 'phone',
        })).toBe(false);
    });

    it('uses the same width contract for wide web and desktop windows', () => {
        expect(shouldUseSplitViewLayout({
            width: 1200,
            platform: 'web',
            isPad: false,
            isMac: false,
            deviceType: 'phone',
        })).toBe(true);
        expect(shouldUseSplitViewLayout({
            width: 700,
            platform: 'web',
            isPad: false,
            isMac: false,
            deviceType: 'phone',
        })).toBe(false);
        expect(shouldUseSplitViewLayout({
            width: 1000,
            platform: 'ios',
            isPad: false,
            isMac: true,
            deviceType: 'tablet',
        })).toBe(true);
    });

    it('requires tablet capability on Android', () => {
        expect(shouldUseSplitViewLayout({
            width: 900,
            platform: 'android',
            isPad: false,
            isMac: false,
            deviceType: 'tablet',
        })).toBe(true);
        expect(shouldUseSplitViewLayout({
            width: 900,
            platform: 'android',
            isPad: false,
            isMac: false,
            deviceType: 'phone',
        })).toBe(false);
    });
});

describe('sidebarWidth', () => {
    it.each([
        [900, 280],
        [1024, 280],
        [1200, 312],
        [1440, 360],
        [2560, 360],
    ])('clamps a %ipx window to a usable sidebar width', (windowWidth, expected) => {
        expect(sidebarWidth(windowWidth)).toBe(expected);
    });
});
