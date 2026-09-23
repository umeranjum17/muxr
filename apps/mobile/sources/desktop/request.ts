import { AppState } from 'react-native';

/**
 * Whether the person asked for the desktop in this run of the app.
 *
 * Opening a desktop starts screen capture, and a saved screen-sharing grant
 * lets the computer start it without asking. So only a tap on the desktop
 * action may start one: a link, or a screen the app puts back on its own,
 * shows the desktop stopped until that tap happens.
 *
 * Its own entry, apart from the feature's index, so the terminal screen can
 * mark a tap without loading the desktop surface.
 */
const tapped = new Set<string>();
/** A tap that no desktop screen has answered yet. */
const pending = new Set<string>();

AppState.addEventListener('change', (state) => {
    if (state === 'background' || state === 'inactive') pending.clear();
});

const requestKey = (machineId: string, sessionId: string) => JSON.stringify([machineId, sessionId]);

/** The person tapped the desktop action. */
export function requestDesktop(machineId: string, sessionId: string): void {
    const key = requestKey(machineId, sessionId);
    tapped.add(key);
    pending.add(key);
}

/** Read during render without consuming a tap until the screen commits. */
export function peekDesktopRequest(machineId: string, sessionId: string): { allowed: boolean; fresh: boolean } {
    const key = requestKey(machineId, sessionId);
    return { allowed: tapped.has(key), fresh: pending.has(key) };
}

/** Consume a tap once a desktop screen has mounted. */
export function claimDesktopRequest(machineId: string, sessionId: string): { allowed: boolean; fresh: boolean } {
    const key = requestKey(machineId, sessionId);
    const fresh = pending.delete(key);
    return { allowed: tapped.has(key), fresh };
}
