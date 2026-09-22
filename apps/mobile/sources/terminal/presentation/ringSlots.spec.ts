import { describe, expect, it, vi } from 'vitest';

import type { RingSlot } from './FloatingTerminalControls';
import { assembleRing, desktopRingSlot } from './ringSlots';

/** The slots a control-granted Android pane builds before the desktop one. */
function baseSlots(): RingSlot[] {
    return ['continue', 'changes', 'keyboard', 'commands', 'paste'].map((id) => ({
        id,
        label: id,
        icon: 'ellipse-outline',
        run: () => undefined,
    }));
}

describe('the ring\u2019s desktop slot', () => {
    it('offers Computer where the action is available', () => {
        const slot = desktopRingSlot(true, vi.fn(), vi.fn());

        expect(slot.id).toBe('computer');
        expect(slot.label).toBe('Computer');
    });

    it('keeps the Browser shortcut where Computer is not offered', () => {
        const browser = vi.fn();
        const slot = desktopRingSlot(false, vi.fn(), browser);

        expect(slot.id).toBe('browser');
        slot.run();
        expect(browser).toHaveBeenCalledTimes(1);
    });
});

describe('the assembled ring on a control-granted pane', () => {
    it('ends in Computer, not Browser, and fits the ring cap', () => {
        const ring = assembleRing(baseSlots(), true, vi.fn(), vi.fn());

        expect(ring.map((slot) => slot.id)).toEqual([
            'continue',
            'changes',
            'keyboard',
            'commands',
            'paste',
            'computer',
        ]);
        expect(ring).toHaveLength(6);
        expect(ring.some((slot) => slot.id === 'browser')).toBe(false);
    });

    it('keeps Browser as the last slot where Computer is not offered', () => {
        const ring = assembleRing(baseSlots(), false, vi.fn(), vi.fn());

        expect(ring.map((slot) => slot.id).at(-1)).toBe('browser');
    });
});
