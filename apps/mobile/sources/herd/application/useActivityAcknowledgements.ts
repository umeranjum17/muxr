import * as React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLifecycleEvents } from '@/catalog/store';
import { unseenDoneSessionIds } from '../domain/recentActivity';

const STORAGE_KEY = 'muxr.herd.seen-activity.v1';
const MAX_SEEN_EVENTS = 128;

// Shared module store: LiveTerminalsRow renders the unseen tiers while the
// session route acks on open, and both must agree within one app session --
// Home stays mounted under a pushed session route, so per-hook state would
// keep showing rows the user just opened.
interface Acknowledgements {
    ready: boolean;
    seenEventIds: ReadonlySet<string>;
}

let snapshot: Acknowledgements = { ready: false, seenEventIds: new Set() };
const listeners = new Set<() => void>();
let loadStarted = false;
let writeChain = Promise.resolve();

function emit(next: Acknowledgements): void {
    snapshot = next;
    for (const listener of listeners) listener();
}

function parseSeen(raw: string | null): Set<string> {
    if (raw === null) return new Set();
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((value): value is string => typeof value === 'string').slice(-MAX_SEEN_EVENTS));
    } catch {
        return new Set();
    }
}

function persist(seen: ReadonlySet<string>): void {
    const snapshotJson = JSON.stringify([...seen]);
    writeChain = writeChain.then(() => AsyncStorage.setItem(STORAGE_KEY, snapshotJson)).catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!loadStarted) {
        loadStarted = true;
        void AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
            // Merge rather than replace: marks made before the read answered stay.
            emit({ ready: true, seenEventIds: new Set([...parseSeen(raw), ...snapshot.seenEventIds]) });
        }).catch(() => {
            emit({ ...snapshot, ready: true });
        });
    }
    return () => { listeners.delete(listener); };
}

function getSnapshot(): Acknowledgements {
    return snapshot;
}

function markSeen(eventIds: readonly string[]): void {
    if (eventIds.length === 0) return;
    const next = new Set(snapshot.seenEventIds);
    for (const eventId of eventIds) next.add(eventId);
    const bounded = new Set([...next].slice(-MAX_SEEN_EVENTS));
    const unchanged = bounded.size === snapshot.seenEventIds.size
        && [...bounded].every((eventId) => snapshot.seenEventIds.has(eventId));
    if (unchanged) return;
    persist(bounded);
    emit({ ...snapshot, seenEventIds: bounded });
}

export function useActivityAcknowledgements(): {
    ready: boolean;
    seenEventIds: ReadonlySet<string>;
    markSeen: (eventIds: readonly string[]) => void;
} {
    const current = React.useSyncExternalStore(subscribe, getSnapshot);
    return { ready: current.ready, seenEventIds: current.seenEventIds, markSeen };
}

/** Sessions whose finished outcome is still unopened — one seen rule, shared by the tier, the strip cards and the Spaces tree. */
export function useUnseenDoneSessionIds(): ReadonlySet<string> {
    const { ready, seenEventIds } = useActivityAcknowledgements();
    const lifecycleEvents = useLifecycleEvents();
    return React.useMemo(
        // Silent until AsyncStorage answers, like the tier: a persisted seen
        // mark would otherwise flash the settled row loud on cold start.
        () => ready ? unseenDoneSessionIds(lifecycleEvents, seenEventIds) : new Set<string>(),
        [ready, lifecycleEvents, seenEventIds],
    );
}
