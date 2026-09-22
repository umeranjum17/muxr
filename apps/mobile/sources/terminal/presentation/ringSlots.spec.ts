import { describe, expect, it, vi } from 'vitest';

import { desktopRingSlot } from './ringSlots';

describe('the ring\u2019s desktop slot', () => {
    it('offers Computer in the last slot where the action is available', () => {
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
