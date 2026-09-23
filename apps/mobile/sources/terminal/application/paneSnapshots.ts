/**
 * The last visible screen read for a pane, shared by everything that shows a
 * pane it is not attached to: Home's tiles write here, and the terminal's
 * agent pager reads its neighbours from here without waiting.
 *
 * A neighbour is kept warm by `pane.read` rather than by attaching to it: a
 * read of the visible screen is passive, while a control attach focuses the
 * pane on the desk, takes it over and resizes it to the phone.
 */

import * as React from 'react';
import { sync } from '@/catalog/sync';

interface Snapshot {
    text: string;
    at: number;
    order: number;
}

/** Enough for every agent a phone can page through, and never more. */
const SNAPSHOT_LIMIT = 32;

const snapshots = new Map<string, Snapshot>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let readOrder = 0;

export function beginPaneSnapshotRead(): number {
    return ++readOrder;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function rememberPaneSnapshot(sessionId: string, text: string, order: number): string {
    const held = snapshots.get(sessionId);
    if (held !== undefined && held.order > order) return held.text;
    snapshots.delete(sessionId);
    snapshots.set(sessionId, { text, at: Date.now(), order });
    if (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
    for (const listener of listeners) listener();
    return text;
}

/** Read the pane again unless the one held is younger than `maxAgeMs`. */
export function refreshPaneSnapshot(sessionId: string, maxAgeMs = 0): Promise<void> {
    const held = snapshots.get(sessionId);
    if (held !== undefined && Date.now() - held.at < maxAgeMs) return Promise.resolve();
    const inFlight = pending.get(sessionId);
    if (inFlight !== undefined) return inFlight;
    const order = beginPaneSnapshotRead();
    const read = sync.request('pane.read', { sessionId, source: 'visible' })
        .then((result) => { rememberPaneSnapshot(sessionId, result.text, order); })
        // A pane that is gone or a host that is busy keeps its last screen.
        .catch(() => undefined)
        .finally(() => pending.delete(sessionId));
    pending.set(sessionId, read);
    return read;
}

export function usePaneSnapshot(sessionId: string | undefined): string | undefined {
    return React.useSyncExternalStore(
        subscribe,
        () => (sessionId === undefined ? undefined : snapshots.get(sessionId)?.text),
    );
}
