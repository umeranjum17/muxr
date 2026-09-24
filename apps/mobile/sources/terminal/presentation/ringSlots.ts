import type { RingSlot } from './FloatingTerminalControls';

/**
 * The assembled ring: the pane's own slots, closed by Computer wherever that
 * action is offered, so no seventh entry can be pushed past the ring's cap and
 * silently truncated.
 */
export function assembleRing(base: RingSlot[], offered: boolean, openComputer: () => void): RingSlot[] {
    if (!offered) return base;
    return [...base, { id: 'computer', label: 'Computer', icon: 'desktop-outline', run: openComputer }];
}
