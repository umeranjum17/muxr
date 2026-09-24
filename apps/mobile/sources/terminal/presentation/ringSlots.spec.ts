import { describe, expect, it, vi } from 'vitest';

import type { RingSlot } from './FloatingTerminalControls';
import { assembleRing } from './ringSlots';

/** The slots a control-granted Android pane builds before the desktop one. */
function baseSlots(): RingSlot[] {
    return ['continue', 'changes', 'keyboard', 'commands', 'paste'].map((id) => ({
        id,
        label: id,
        icon: 'ellipse-outline',
        run: () => undefined,
    }));
}

describe('the assembled ring on a control-granted pane', () => {
    it('ends in Computer and fits the ring cap', () => {
        const openComputer = vi.fn();
        const ring = assembleRing(baseSlots(), true, openComputer);

        expect(ring.map((slot) => slot.id)).toEqual(['continue', 'changes', 'keyboard', 'commands', 'paste', 'computer']);
        ring.at(-1)?.run();
        expect(openComputer).toHaveBeenCalledTimes(1);
    });

    it('offers no desktop slot where Computer is not available', () => {
        expect(assembleRing(baseSlots(), false, vi.fn()).map((slot) => slot.id)).toEqual(['continue', 'changes', 'keyboard', 'commands', 'paste']);
    });
});
