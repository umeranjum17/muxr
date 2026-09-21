import { describe, expect, it, vi } from 'vitest';

import { computerRingSlot } from './ringSlots';

describe('the Computer ring slot', () => {
    it('is absent on a platform with no desktop surface', () => {
        expect(computerRingSlot(false, () => undefined)).toBeNull();
    });

    it('opens the desktop where a surface exists', () => {
        const open = vi.fn();
        const slot = computerRingSlot(true, open);

        expect(slot?.id).toBe('computer');
        slot?.run();
        expect(open).toHaveBeenCalledTimes(1);
    });
});
