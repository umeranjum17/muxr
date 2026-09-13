/**
 * Open surfaces are listed where tools already live (sidebar Tools, the
 * session's pane actions); the workspace owns which one is shown. This is
 * the one-way channel between them: a focus request in, the shown name out.
 */
import { useSyncExternalStore } from 'react';

interface FocusRequest { sessionId: string; name: string; seq: number }

let request: FocusRequest | null = null;
let shown: { sessionId: string; name: string | null } | null = null;
const listeners = new Set<() => void>();
const notify = (): void => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function requestSurfaceFocus(sessionId: string, name: string): void {
    request = { sessionId, name, seq: (request?.seq ?? 0) + 1 };
    notify();
}

export function useSurfaceFocusRequest(sessionId: string): FocusRequest | null {
    return useSyncExternalStore(subscribe, () => (request?.sessionId === sessionId ? request : null));
}

export function reportShownSurface(sessionId: string, name: string | null): void {
    if (shown?.sessionId === sessionId && shown.name === name) return;
    shown = { sessionId, name };
    notify();
}

export function useShownSurface(sessionId: string): string | null {
    return useSyncExternalStore(subscribe, () => (shown?.sessionId === sessionId ? shown.name : null));
}
