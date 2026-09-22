import type { RingSlot } from './FloatingTerminalControls';

/**
 * The ring's last slot. The Computer action takes it wherever it is offered and
 * the legacy Browser shortcut keeps it otherwise; Browser's permanent route is
 * in the pane-actions menu either way.
 */
export function desktopRingSlot(offered: boolean, openComputer: () => void, openBrowser: () => void): RingSlot {
    if (offered) return { id: 'computer', label: 'Computer', icon: 'desktop-outline', run: openComputer };
    return { id: 'browser', label: 'Browser', icon: 'globe-outline', run: openBrowser };
}

/**
 * The assembled ring: the pane's own slots plus exactly one desktop slot, so no
 * seventh entry can be pushed past the ring's cap and silently truncated.
 */
export function assembleRing(
    base: RingSlot[],
    offered: boolean,
    openComputer: () => void,
    openBrowser: () => void,
): RingSlot[] {
    return [...base, desktopRingSlot(offered, openComputer, openBrowser)];
}
