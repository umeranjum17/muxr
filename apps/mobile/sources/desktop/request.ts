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

/** Where on screen the tap came from, so the view can grow out of it. */
export interface DesktopOrigin { x: number; y: number; width: number; height: number }
const origins = new Map<string, DesktopOrigin>();

/**
 * The computer's desktop, or (`preview`) the session's own screen: the
 * browser, emulator, or claimed simulator its agent is showing. A tap on one never opens the other.
 */
const requestKey = (machineId: string, sessionId: string, preview: boolean) => JSON.stringify([machineId, sessionId, preview]);

/**
 * The person tapped the desktop action, or Watch on an agent's browser.
 * The presence chip (PreviewChip, P1.4) passes its measured rect as `from`.
 */
export function requestDesktop(machineId: string, sessionId: string, preview = false, from?: DesktopOrigin): void {
    const key = requestKey(machineId, sessionId, preview);
    tapped.add(key);
    pending.add(key);
    if (from === undefined) origins.delete(key);
    else origins.set(key, from);
}

/** Read during render without consuming a tap until the screen commits. */
export function peekDesktopRequest(machineId: string, sessionId: string, preview = false): { allowed: boolean; fresh: boolean; from?: DesktopOrigin } {
    const key = requestKey(machineId, sessionId, preview);
    const fresh = pending.has(key);
    return { allowed: tapped.has(key), fresh, ...(fresh && origins.has(key) ? { from: origins.get(key) } : {}) };
}

/** Consume a tap once a desktop screen has mounted. */
export function claimDesktopRequest(machineId: string, sessionId: string, preview = false): { allowed: boolean; fresh: boolean } {
    const key = requestKey(machineId, sessionId, preview);
    const fresh = pending.delete(key);
    origins.delete(key);
    return { allowed: tapped.has(key), fresh };
}

/** A wide web window docks the agent's browser beside the conversation instead of over it. */
export const PREVIEW_DOCK = { minWindowWidth: 900, width: 600 } as const;
export const previewDocks = (web: boolean, windowWidth: number): boolean => web && windowWidth >= PREVIEW_DOCK.minWindowWidth;
