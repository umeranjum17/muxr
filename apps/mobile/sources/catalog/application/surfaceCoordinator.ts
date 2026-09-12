import * as React from 'react';
import type { SurfaceOffer, SurfaceOfferHostFrame } from '@muxr/contract';

/**
 * Bounded mobile Surface coordinator.
 *
 * One store for host-originated `surface.offer` frames, fed by sync. Keyed
 * by exact machine + session + handle: the machine id comes from the live
 * connection (never from the frame), the session and handle travel inside
 * the encrypted frame alone. Handles, sessions, panes, leases and device
 * ids are never displayed; the UI names the logical surface only.
 *
 * Rules, all local and fail-closed:
 * - only monotonic current revisions apply; replay is idempotent;
 * - close removes by handle; expiry removes on read and on ingest;
 * - a user Close dismisses that exact handle; a newer revision may appear;
 * - retained entries are capped; the oldest goes first;
 * - a reload executes once per command: renewal re-emits keep their
 *   command and never execute, duplicates of an executed command are
 *   ignored, out-of-order commands run nothing, a missing command never
 *   executes, and replaced, closed, or expired handles never execute
 *   again. The per-handle command watermark is a monotonic max: an older
 *   frame arriving late cannot lower it and re-arm a duplicate.
 */
export interface SurfaceEntry {
    machineId: string;
    sessionId: string;
    handle: string;
    name: string;
    revision: number;
    expiresAt: number;
    offer: SurfaceOffer;
    operation: 'open' | 'update' | 'reload';
    /** Last command identity seen for this handle. Monotonic per handle. */
    command: number | undefined;
    receivedAt: number;
}

const MAX_RETAINED_ENTRIES = 16;
const MAX_DISMISSED_HANDLES = 32;

const byHandle = new Map<string, SurfaceEntry>();
const dismissed = new Set<string>();
const listeners = new Set<() => void>();
/**
 * Reload commands already executed, by handle: each runs exactly once.
 * Monotonic max watermark -- never regresses, even when an older frame
 * arrives late.
 */
const executedReload = new Map<string, number>();
/**
 * Handles whose offer generation was replaced or closed: reload frames
 * for them never execute again, however fresh their command looks. A
 * replaced handle is dead; only its successor may carry orders. Bounded
 * like the dismiss set.
 */
const deadReloadHandles = new Set<string>();
const MAX_DEAD_RELOAD_HANDLES = 128;
const reloadListeners = new Set<(handle: string, command: number) => void>();
let clock: () => number = Date.now;

/** Test seam: deterministic time without touching global state. */
export function setSurfaceCoordinatorClock(fn: () => number): void {
    clock = fn;
}

function notify(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            /* one subscriber must not block the others */
        }
    }
}

export function subscribeSurfaceEntries(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Fires once per reload command for the given handle, with the command
 * identity. The mounted surface calls `reload()` from here -- immediately
 * or parked behind Show under the interaction policy; renewal re-emits
 * and duplicates never reach it. Bound the map with the entries: handles
 * nobody retains execute nothing.
 */
export function onSurfaceReload(listener: (handle: string, command: number) => void): () => void {
    reloadListeners.add(listener);
    return () => {
        reloadListeners.delete(listener);
    };
}

function retireReloadHandle(handle: string): void {
    deadReloadHandles.add(handle);
    while (deadReloadHandles.size > MAX_DEAD_RELOAD_HANDLES) {
        const oldest = deadReloadHandles.values().next().value;
        if (oldest === undefined) break;
        deadReloadHandles.delete(oldest);
    }
    executedReload.delete(handle);
}

function sweep(): void {
    const now = clock();
    for (const [handle, entry] of [...byHandle]) {
        if (entry.expiresAt <= now) {
            byHandle.delete(handle);
            // Expiry retires the handle exactly like replace and close:
            // a replayed frame for it must never execute again.
            retireReloadHandle(handle);
        }
    }
    for (const handle of [...executedReload.keys()]) {
        if (!byHandle.has(handle)) executedReload.delete(handle);
    }
}

function siblingOf(machineId: string, sessionId: string, name: string, exceptHandle: string): SurfaceEntry | undefined {
    for (const entry of byHandle.values()) {
        if (entry.handle === exceptHandle) continue;
        if (entry.machineId === machineId && entry.sessionId === sessionId && entry.name === name) return entry;
    }
    return undefined;
}

/**
 * Feed one host-authenticated offer frame into the store. The machine id is
 * the caller's live connection scope, not frame content. Stale, replaced,
 * expired, dismissed and over-cap entries never become visible.
 */
export function ingestSurfaceOffer(machineId: string, frame: SurfaceOfferHostFrame): void {
    sweep();
    if (machineId === '') return;
    if (frame.operation === 'close') {
        dismissed.delete(frame.handle);
        const existing = byHandle.get(frame.handle);
        if (existing === undefined) return;
        if (frame.revision < existing.revision) return;
        byHandle.delete(frame.handle);
        // Closed handles never execute again: a replayed reload frame for
        // a closed handle is not an order for anything mounted.
        retireReloadHandle(frame.handle);
        notify();
        return;
    }
    if (dismissed.has(frame.handle)) return;
    const offer = frame.offer;
    if (offer === undefined) return;
    if (frame.expiresAt <= clock()) return;
    const existing = byHandle.get(frame.handle);
    // Session binding first: a frame naming another session for a known
    // handle is not state for this one and never an order for it.
    if (existing !== undefined && frame.sessionId !== existing.sessionId) return;
    if (existing !== undefined) {
        if (frame.revision < existing.revision) return;
        if (frame.revision === existing.revision && existing.operation === frame.operation
            && frame.command === existing.command) {
            // Renewal re-emits the exact record with a later expiry: adopt
            // it so a live surface never sweeps underneath itself. The
            // command is unchanged, so no order executes below. A new
            // command on the same record falls through: that is an order.
            if (frame.expiresAt > existing.expiresAt) {
                existing.expiresAt = frame.expiresAt;
                notify();
            }
            return;
        }
    }
    const sibling = siblingOf(machineId, frame.sessionId, offer.name, frame.handle);
    if (sibling !== undefined) {
        if (frame.revision < sibling.revision) return;
        if (frame.revision === sibling.revision) return;
    }
    if (frame.operation === 'reload' && frame.command !== undefined) {
        // An order, not state -- accepted only after the machine, session,
        // and revision checks above, and never for a replaced, closed, or
        // expired handle. It executes once, and only when its command
        // identity is fresh: strictly greater than the monotonic max
        // watermark this handle ever carried. A renewal re-emit keeps its
        // command precisely so it is never an order; a duplicate replays
        // an executed command; an out-of-order command runs nothing; a
        // missing command never executes. The watermark never regresses:
        // an older frame arriving late cannot lower it and re-arm a
        // duplicate of a newer command. The renderer applies its own
        // interaction policy before acting on the single firing.
        if (!deadReloadHandles.has(frame.handle)) {
            const recorded = executedReload.get(frame.handle);
            const lastCommand = existing?.command === undefined
                ? recorded
                : Math.max(existing.command, recorded ?? existing.command);
            if (lastCommand === undefined || frame.command > lastCommand) {
                executedReload.set(frame.handle, frame.command);
                for (const listener of [...reloadListeners]) {
                    try {
                        listener(frame.handle, frame.command);
                    } catch {
                        /* one subscriber must not block the others */
                    }
                }
            }
        }
    }
    // The stored command is the monotonic max of everything seen for this
    // handle: an older frame arriving late adopts the newer watermark
    // instead of overwriting it, so 3 -> 2 -> 3 executes 3 exactly once.
    const storedCommand = frame.command === undefined
        ? existing?.command
        : Math.max(frame.command, existing?.command ?? frame.command, executedReload.get(frame.handle) ?? frame.command);
    const entry: SurfaceEntry = {
        machineId,
        sessionId: frame.sessionId,
        handle: frame.handle,
        name: offer.name,
        revision: frame.revision,
        expiresAt: frame.expiresAt,
        offer,
        operation: frame.operation,
        command: storedCommand,
        receivedAt: clock(),
    };
    byHandle.set(frame.handle, entry);
    if (sibling !== undefined) {
        byHandle.delete(sibling.handle);
        // Replaced handles never execute again: the successor alone may
        // carry orders from here on.
        retireReloadHandle(sibling.handle);
    }
    while (byHandle.size > MAX_RETAINED_ENTRIES) {
        let oldest: string | undefined;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [handle, candidate] of byHandle) {
            if (candidate.receivedAt < oldestAt) {
                oldestAt = candidate.receivedAt;
                oldest = handle;
            }
        }
        if (oldest === undefined) break;
        byHandle.delete(oldest);
    }
    notify();
}

/** Dismiss one exact revision locally. A newer revision may still appear. */
export function dismissSurfaceOffer(handle: string): void {
    dismissed.add(handle);
    while (dismissed.size > MAX_DISMISSED_HANDLES) {
        const oldest = dismissed.values().next().value;
        if (oldest === undefined) break;
        dismissed.delete(oldest);
    }
    if (byHandle.delete(handle)) notify();
    else notify();
}

/** Visible entries for one exact machine + session scope. Swept and sorted. */
export function listSurfaceEntries(machineId: string, sessionId: string): SurfaceEntry[] {
    sweep();
    const out: SurfaceEntry[] = [];
    for (const entry of byHandle.values()) {
        if (entry.machineId !== machineId || entry.sessionId !== sessionId) continue;
        if (dismissed.has(entry.handle)) continue;
        out.push(entry);
    }
    out.sort((left, right) => left.receivedAt - right.receivedAt);
    return out;
}

/**
 * The current live record for one logical surface name in scope: the
 * newest revision that is neither dismissed nor expired. Selection keys on
 * this name, never on the handle, because an update replaces the handle and
 * handle-based selection would drop the surface on every revision.
 */
export function findSurfaceEntry(machineId: string, sessionId: string, name: string): SurfaceEntry | undefined {
    sweep();
    let best: SurfaceEntry | undefined;
    for (const entry of byHandle.values()) {
        if (entry.machineId !== machineId || entry.sessionId !== sessionId || entry.name !== name) continue;
        if (dismissed.has(entry.handle)) continue;
        if (best === undefined || entry.revision > best.revision) best = entry;
    }
    return best;
}

/** React hook for one session scope. Re-renders only when the store changes. */
export function useSurfaceEntries(machineId: string, sessionId: string): SurfaceEntry[] {
    const [tick, bump] = React.useReducer((count: number) => count + 1, 0);
    React.useEffect(() => subscribeSurfaceEntries(bump), []);
    return React.useMemo(() => listSurfaceEntries(machineId, sessionId), [machineId, sessionId, tick]);
}

/** Test seam: clear retained and dismissed state. */
export function clearSurfaceEntries(): void {
    byHandle.clear();
    dismissed.clear();
    executedReload.clear();
    deadReloadHandles.clear();
    notify();
}
