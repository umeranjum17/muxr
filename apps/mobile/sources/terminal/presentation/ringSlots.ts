import type { RingSlot } from './FloatingTerminalControls';

/**
 * The Computer ring slot. It opens this machine's own desktop inside the
 * conversation, so it exists only where a desktop surface does.
 */
export function computerRingSlot(desktopSurface: boolean, open: () => void): RingSlot | null {
    if (!desktopSurface) return null;
    return { id: 'computer', label: 'Computer', icon: 'desktop-outline', run: open };
}
