import { describe, expect, it } from 'vitest';
import { containRect, mapDisplayToInput, type StreamFrameMetadata } from './coordinates';

const METADATA: StreamFrameMetadata = {
    deviceWidth: 1280,
    deviceHeight: 720,
    pageScaleFactor: 1,
    offsetTop: 0,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
};

describe('takeover coordinate mapping', () => {
    it('maps display space to device space one-to-one when the aspect ratios match', () => {
        // A 640x360 render of a 1280x720 frame: half scale, no letterbox.
        expect(mapDisplayToInput({ x: 320, y: 180 }, { width: 640, height: 360 }, METADATA)).toEqual({ x: 640, y: 360 });
        expect(mapDisplayToInput({ x: 0, y: 0 }, { width: 640, height: 360 }, METADATA)).toEqual({ x: 0, y: 0 });
        expect(mapDisplayToInput({ x: 640, y: 360 }, { width: 640, height: 360 }, METADATA)).toEqual({ x: 1280, y: 720 });
    });

    it('divides device pixels by a non-1 pageScaleFactor to reach CSS pixels', () => {
        // Retina capture: 1280x720 device pixels at 2x is a 640x360 CSS page,
        // so the centre of the frame is (320, 180), not (640, 360).
        const retina = { ...METADATA, pageScaleFactor: 2 };
        expect(mapDisplayToInput({ x: 320, y: 180 }, { width: 640, height: 360 }, retina)).toEqual({ x: 320, y: 180 });
        expect(mapDisplayToInput({ x: 640, y: 360 }, { width: 640, height: 360 }, retina)).toEqual({ x: 640, y: 360 });
    });

    it('maps through the letterboxed rect when the phone and frame aspects differ', () => {
        // A 1280x720 landscape frame contained in a 400x800 portrait screen:
        // rendered 400x225, centred with a 287.5px bar above and below.
        const display = { width: 400, height: 800 };
        const rect = containRect(display, { width: 1280, height: 720 });
        expect(rect.width).toBeCloseTo(400);
        expect(rect.height).toBeCloseTo(225);
        expect(rect.y).toBeCloseTo(287.5);

        // Centre of the rendered image is the centre of the page.
        expect(mapDisplayToInput({ x: 200, y: 400 }, display, METADATA)).toEqual({ x: 640, y: 360 });
        // A tap a quarter of the way across the rendered image lands a quarter across the page.
        expect(mapDisplayToInput({ x: 100, y: 287.5 + 56.25 }, display, METADATA)).toEqual({ x: 320, y: 180 });
        // Taps in the letterbox bars clamp to the frame edge instead of firing past it.
        expect(mapDisplayToInput({ x: 200, y: 100 }, display, METADATA)).toEqual({ x: 640, y: 0 });
        expect(mapDisplayToInput({ x: 200, y: 799 }, display, METADATA)).toEqual({ x: 640, y: 720 });
    });

    it('adds scroll and chrome offsets after scaling', () => {
        const scrolled = { ...METADATA, pageScaleFactor: 2, offsetTop: 80, scrollOffsetX: 40, scrollOffsetY: 1200 };
        expect(mapDisplayToInput({ x: 320, y: 180 }, { width: 640, height: 360 }, scrolled)).toEqual({ x: 360, y: 1460 });
    });
});
