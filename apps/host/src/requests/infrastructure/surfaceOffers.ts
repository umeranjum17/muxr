/**
 * Host-memory Surface offer registry (Slice 2A).
 *
 * Offers are the host's own record of what a surface may show: the validated
 * target (direct HTTPS, host-local port/path/label/context, or code-review
 * anchor), the semantic capability it needs, placement intent only, a
 * monotonic revision per logical name, a bounded name/title, and an expiry.
 *
 * Open, update and close are idempotent and context-bound: repeating the
 * current target for a logical name returns the current handle, and closing
 * an unknown name is already gone. Every open/update mints a fresh opaque
 * handle; the previous handle for that name is replaced and fails closed,
 * which is what makes a stale phone-side offer unable to mint a lease.
 *
 * Product `preview.lease` consumes a current local Browser offer handle and
 * resolves port, provider and context from this table. Direct-HTTPS and Code
 * offers never create leases: resolving one is a refusal, not a fallback.
 */

import { randomUUID } from 'node:crypto';
import {
    SURFACE_OFFER_VERSION,
    isSurfaceSessionId,
    parseSurfaceOfferInput,
    type SurfaceOffer,
    type SurfaceOfferInput,
} from '@muxr/contract';

export interface SurfaceOfferRecord {
    handle: string;
    context: string;
    /** The exact live agent session this offer belongs to. Undefined only for
     * sessionless records, which emit no HostFrame and exist for the device
     * request path. */
    sessionId: string | undefined;
    revision: number;
    expiresAt: number;
    offer: SurfaceOffer;
    /**
     * Monotonic command identity for this logical surface. Every emitted
     * open, update, reload, and close carries the next number; renewal
     * re-emits keep it, so a renewal is never mistaken for an order.
     */
    command: number;
    /** Earlier handle for this name that a retry may still quote. Failed closed. */
    replaced: boolean;
    closed: boolean;
}

export type SurfaceOfferOperation = 'open' | 'update' | 'reload' | 'close';

export interface SurfaceOfferEvent {
    operation: SurfaceOfferOperation;
    record: SurfaceOfferRecord;
}

export interface SurfaceOfferRegistry {
    /** Open or idempotently refresh the named offer in this session scope. */
    open(input: unknown, context: unknown, sessionId?: unknown): SurfaceOfferRecord;
    /** The current live record for a handle. Throws when stale. */
    resolve(handle: unknown): SurfaceOfferRecord;
    /** Current live record for a name in a scope, if any. */
    current(name: string, context: unknown, sessionId?: unknown): SurfaceOfferRecord | undefined;
    /** Re-emit the live record for a handle without changing it. Throws when stale. */
    refresh(handle: string): SurfaceOfferRecord;
    /**
     * Renew the live record for a handle: extend its expiry by one TTL and
     * re-emit it unchanged (same handle, same revision). Returns undefined
     * when the record is no longer live instead of throwing, so lease
     * renewal can call it unconditionally. A selected surface renewed this
     * way never watches its offer expire underneath a live tunnel.
     */
    renew(handle: string): SurfaceOfferRecord | undefined;
    /** Visible offers, newest revision first. Handles never leave this table. */
    list(filter?: { context?: string; sessionId?: string }): SurfaceOffer[];
    /** Live records with handles, for reconnect replay. Sweeps first. */
    records(): SurfaceOfferRecord[];
    /** Close one logical surface. Idempotent. */
    close(name: string, context: unknown, sessionId?: unknown): void;
    /** Subscribed by the host to fan offer frames out to devices. */
    onEvent: ((event: SurfaceOfferEvent) => void) | undefined;
    size(): number;
}

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_OFFERS = 32;

function cleanContext(value: unknown): string {
    if (typeof value !== 'string') throw new Error('surface offer context is invalid');
    const clean = value.replace(/[\0-\x1F\x7F]/g, '').trim();
    if (clean === '' || clean.length > 1024) throw new Error('surface offer context is invalid');
    return clean;
}

/** Session scope for idempotency: an exact session, else the bare context. */
function cleanSessionId(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (!isSurfaceSessionId(value)) throw new Error('surface offer session is invalid');
    return value;
}

function sameTarget(left: SurfaceOffer, right: SurfaceOfferInput): boolean {
    if (left.kind !== right.kind || left.capability !== right.capability || left.name !== right.name) return false;
    if ((left.title ?? left.name) !== (right.title ?? right.name)) return false;
    if ((left.placement ?? 'replace') !== (right.placement ?? 'replace')) return false;
    if (left.provider !== right.provider) return false;
    if (left.kind === 'browser-direct' && right.kind === 'browser-direct') return left.url === right.url;
    if (left.kind === 'browser-local' && right.kind === 'browser-local') {
        return left.port === right.port
            && (left.path ?? '/') === (right.path ?? '/')
            && left.label === right.label
            && left.context === right.context;
    }
    if (left.kind === 'code-review' && right.kind === 'code-review') {
        return left.path === right.path
            && (left.line ?? 0) === (right.line ?? 0)
            && (left.column ?? 0) === (right.column ?? 0)
            && (left.endLine ?? 0) === (right.endLine ?? 0)
            && (left.revisionText ?? '') === (right.revisionText ?? '')
            && left.destination === (right.destination ?? 'file');
    }
    return false;
}

function materialize(input: SurfaceOfferInput, revision: number, expiresAt: number): SurfaceOffer {
    const title = input.title ?? input.name;
    const placement = input.placement ?? 'replace';
    if (input.kind === 'browser-direct') {
        return {
            version: SURFACE_OFFER_VERSION,
            capability: input.capability,
            name: input.name,
            title,
            placement,
            revision,
            expiresAt,
            kind: input.kind,
            url: input.url,
            provider: input.provider,
        };
    }
    if (input.kind === 'browser-local') {
        return {
            version: SURFACE_OFFER_VERSION,
            capability: input.capability,
            name: input.name,
            title,
            placement,
            revision,
            expiresAt,
            kind: input.kind,
            port: input.port,
            path: input.path ?? '/',
            label: input.label,
            context: input.context,
            provider: input.provider,
        };
    }
    return {
        version: SURFACE_OFFER_VERSION,
        capability: input.capability,
        name: input.name,
        title,
        placement,
        revision,
        expiresAt,
        kind: input.kind,
        path: input.path,
        ...(input.line === undefined ? {} : { line: input.line }),
        ...(input.column === undefined ? {} : { column: input.column }),
        ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
        ...(input.revisionText === undefined ? {} : { revisionText: input.revisionText }),
        destination: input.destination ?? 'file',
        provider: input.provider,
        mode: 'review',
    };
}

export function createSurfaceOffers(options: { ttlMs?: number; now?: () => number } = {}): SurfaceOfferRegistry {
    const now = options.now ?? Date.now;
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    const byHandle = new Map<string, SurfaceOfferRecord>();
    const currentByName = new Map<string, SurfaceOfferRecord>();
    let commandSeq = 0;
    const nextCommand = (): number => {
        commandSeq += 1;
        return commandSeq;
    };

    const keyOf = (record: Pick<SurfaceOfferRecord, 'context' | 'offer'> & { sessionId: string | undefined }): string =>
        `${record.sessionId ?? `ctx:${record.context}`}\0${record.offer.name}`;

    const sweep = (): void => {
        const at = now();
        for (const record of [...byHandle.values()]) {
            if (record.expiresAt <= at || record.closed) {
                byHandle.delete(record.handle);
                if (currentByName.get(keyOf(record)) === record) {
                    currentByName.delete(keyOf(record));
                }
            }
        }
    };

    const registry: SurfaceOfferRegistry = {
        onEvent: undefined,

        open(input: unknown, context: unknown, sessionId?: unknown) {
            const parsed = parseSurfaceOfferInput(input);
            const resolvedContext = cleanContext(context);
            const session = cleanSessionId(sessionId);
            sweep();
            const key = `${session ?? `ctx:${resolvedContext}`}\0${parsed.name}`;
            const existing = currentByName.get(key);
            if (existing !== undefined && sameTarget(existing.offer, parsed)) return existing;
            if (currentByName.size >= MAX_OFFERS && existing === undefined) {
                throw new Error('too many open surfaces; close one and try again');
            }
            const at = now();
            const revision = (existing?.revision ?? 0) + 1;
            const record: SurfaceOfferRecord = {
                handle: `sfo_${randomUUID().replaceAll('-', '')}`,
                context: resolvedContext,
                sessionId: session,
                revision,
                expiresAt: at + ttl,
                offer: materialize(parsed, revision, at + ttl),
                command: nextCommand(),
                replaced: false,
                closed: false,
            };
            if (existing !== undefined) {
                existing.replaced = true;
                byHandle.delete(existing.handle);
            }
            byHandle.set(record.handle, record);
            currentByName.set(key, record);
            registry.onEvent?.({ operation: existing === undefined ? 'open' : 'update', record });
            return record;
        },

        resolve(handle: unknown) {
            if (typeof handle !== 'string') throw new Error('that surface is no longer open; open it again');
            sweep();
            const record = byHandle.get(handle);
            if (record === undefined || record.replaced || record.closed || record.expiresAt <= now()) {
                throw new Error('that surface is no longer open; open it again');
            }
            const current = currentByName.get(keyOf(record));
            if (current !== record) throw new Error('that surface was replaced; open it again');
            return record;
        },

        refresh(handle: unknown) {
            const record = registry.resolve(handle);
            record.command = nextCommand();
            registry.onEvent?.({ operation: 'reload', record });
            return record;
        },

        renew(handle: unknown) {
            if (typeof handle !== 'string') return undefined;
            let record: SurfaceOfferRecord;
            try {
                record = registry.resolve(handle);
            } catch {
                return undefined;
            }
            record.expiresAt = now() + ttl;
            record.offer = { ...record.offer, expiresAt: record.expiresAt };
            registry.onEvent?.({ operation: 'reload', record });
            return record;
        },

        current(name: string, context: unknown, sessionId?: unknown) {
            sweep();
            const resolvedContext = cleanContext(context);
            const session = cleanSessionId(sessionId);
            return currentByName.get(`${session ?? `ctx:${resolvedContext}`}\0${name}`);
        },

        list(filter?: { context?: string; sessionId?: string }) {
            sweep();
            const scoped = filter?.context === undefined ? undefined : cleanContext(filter.context);
            return [...currentByName.values()]
                .filter((record) => scoped === undefined || record.context === scoped)
                .filter((record) => filter?.sessionId === undefined || record.sessionId === filter.sessionId)
                .sort((left, right) => right.revision - left.revision)
                .map((record) => record.offer);
        },

        records() {
            sweep();
            return [...currentByName.values()].sort((left, right) => right.revision - left.revision);
        },

        close(name: unknown, context: unknown, sessionId?: unknown) {
            if (typeof name !== 'string') return;
            const resolvedContext = cleanContext(context);
            const session = cleanSessionId(sessionId);
            const key = `${session ?? `ctx:${resolvedContext}`}\0${name}`;
            const existing = currentByName.get(key);
            if (existing === undefined) return;
            existing.closed = true;
            existing.command = nextCommand();
            byHandle.delete(existing.handle);
            currentByName.delete(key);
            registry.onEvent?.({ operation: 'close', record: { ...existing } });
        },

        size() {
            sweep();
            return currentByName.size;
        },
    };
    return registry;
}
