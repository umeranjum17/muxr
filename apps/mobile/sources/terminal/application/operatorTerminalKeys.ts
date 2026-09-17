import * as React from 'react';
import type { TerminalKeyDefinition } from '@muxr/contract';
import { storage } from '@/catalog/store';
import { sync } from '@/catalog/sync';

/**
 * The operator's declared terminal keys and quick replies, read from the
 * host's `$MUXR_HOME/config.json` through `terminal.keys`. Fetched once per
 * connection; a socket reconnect or machine switch refetches, so a file edit
 * plus reconnect lands without an app restart. Absent means the operator has
 * declared nothing and the phone follows its own defaults.
 */

export type OperatorTerminalKeys = { keys?: TerminalKeyDefinition[]; quickReplies?: { label: string; text: string }[] };

let snapshot: OperatorTerminalKeys | undefined;
let inflight: Promise<void> | undefined;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) {
        try { listener(); } catch { /* one listener must not block the others */ }
    }
}

export function refreshOperatorTerminalKeys(): Promise<void> {
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
        try {
            snapshot = await sync.request('terminal.keys', {}) as OperatorTerminalKeys;
            emit();
        } catch {
            // An older host without the request keeps the built-in row.
        } finally {
            inflight = undefined;
        }
    })();
    return inflight;
}

// Refetch on every fresh connection (first connect, reconnect, machine switch).
let lastStatus: string | undefined;
storage.subscribe((state) => {
    if (state.socketStatus === 'connected' && lastStatus !== 'connected') void refreshOperatorTerminalKeys();
    lastStatus = state.socketStatus;
});

export function useOperatorTerminalKeys(): OperatorTerminalKeys | undefined {
    const [current, setCurrent] = React.useState(snapshot);
    React.useEffect(() => {
        const update = () => setCurrent(snapshot);
        listeners.add(update);
        void refreshOperatorTerminalKeys();
        update();
        return () => { listeners.delete(update); };
    }, []);
    return current;
}
