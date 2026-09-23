import { describe, expect, it } from 'vitest';
import { FOCUS_BACK_SIZE, FOCUS_BACK_TOP, focusDockMaxHeight } from './focusDockLayout';

/** Where the dock's top lands once it is raised by the keyboard and bounded. */
function dockTop(frame: { height: number; safeTop: number; safeBottom: number; keyboard: number }, natural: number): number {
    const raised = frame.keyboard > 0 ? frame.keyboard - frame.safeBottom : 0;
    return frame.height - raised - Math.min(natural, focusDockMaxHeight(frame));
}

describe('open composer dock', () => {
    // Pickers, Start and the composer with an image attached, as laid out today.
    const natural = 4 * 43 + 52 + 10 + 206 + 8;
    const backBottom = (safeTop: number) => safeTop + FOCUS_BACK_TOP + FOCUS_BACK_SIZE;

    it('stays clear of the back control as the window shrinks, and only scrolls when it must', () => {
        for (const height of [891, 780, 700, 640, 594, 560, 480]) {
            for (const keyboard of [0, 290, 340]) {
                const frame = { height, safeTop: 24, safeBottom: 16, keyboard };
                const bounded = focusDockMaxHeight(frame) < natural;
                expect(dockTop(frame, natural)).toBeGreaterThanOrEqual(backBottom(24));
                // A dock that fits is never touched: it sits exactly where it did.
                if (!bounded) expect(dockTop(frame, natural)).toBe(height - (keyboard > 0 ? keyboard - 16 : 0) - natural);
            }
        }
        // The reference phone (270x594pt) with the keyboard up has to scroll; a roomy one does not.
        expect(focusDockMaxHeight({ height: 594, safeTop: 24, safeBottom: 0, keyboard: 290 })).toBeLessThan(natural);
        expect(focusDockMaxHeight({ height: 891, safeTop: 24, safeBottom: 16, keyboard: 290 })).toBeGreaterThanOrEqual(natural);
    });
});
