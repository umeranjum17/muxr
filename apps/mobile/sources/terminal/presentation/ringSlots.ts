import type { RingSlot } from './FloatingTerminalControls';

/**
 * The ring's last slot. The Computer action takes it wherever it is offered, so
 * the ring never grows past its cap and never builds a disc that is not drawn;
 * the legacy Browser shortcut keeps it otherwise, and its permanent route is in
 * the pane-actions menu either way.
 */
export function desktopRingSlot(offered: boolean, openComputer: () => void, openBrowser: () => void): RingSlot {
    if (offered) return { id: 'computer', label: 'Computer', icon: 'desktop-outline', run: openComputer };
    return { id: 'browser', label: 'Browser', icon: 'globe-outline', run: openBrowser };
}
