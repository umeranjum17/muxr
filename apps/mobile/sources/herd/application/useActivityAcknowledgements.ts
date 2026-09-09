import * as React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'muxr.herd.seen-activity.v1';
const MAX_SEEN_EVENTS = 128;
let writeChain = Promise.resolve();

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
    const snapshot = JSON.stringify([...seen]);
    writeChain = writeChain.then(() => AsyncStorage.setItem(STORAGE_KEY, snapshot)).catch(() => undefined);
}

export function useActivityAcknowledgements(): {
    ready: boolean;
    seenEventIds: ReadonlySet<string>;
    markSeen: (eventIds: readonly string[]) => void;
} {
    const [ready, setReady] = React.useState(false);
    const [seenEventIds, setSeenEventIds] = React.useState<ReadonlySet<string>>(new Set());

    React.useEffect(() => {
        let alive = true;
        void AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
            if (!alive) return;
            setSeenEventIds(parseSeen(raw));
            setReady(true);
        }).catch(() => {
            if (alive) setReady(true);
        });
        return () => { alive = false; };
    }, []);

    const markSeen = React.useCallback((eventIds: readonly string[]) => {
        if (eventIds.length === 0) return;
        setSeenEventIds((current) => {
            const next = new Set(current);
            for (const eventId of eventIds) next.add(eventId);
            const bounded = new Set([...next].slice(-MAX_SEEN_EVENTS));
            persist(bounded);
            return bounded;
        });
    }, []);

    return { ready, seenEventIds, markSeen };
}
