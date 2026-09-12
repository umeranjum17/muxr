/**
 * Endpoint leases for preview surfaces.
 *
 * Before this, a caller named a port and the host dialled it. A lease turns
 * that around: the host writes down which endpoint a given device may reach,
 * for which surface kind, under which provider, context and plugin snapshot,
 * and until when. Attach quotes a lease and nothing else, so a request can only
 * ever reach an endpoint this machine already recorded.
 *
 * Three rules the registry owns, because every one of them was a hole:
 *
 * 1. Standing is re-read, never remembered. Expiry, a device whose grant has
 *    gone or expired, a provider that is no longer enabled, a catalog the host
 *    cannot read -- each ends the lease and closes the listener it holds. An
 *    authority port that throws counts as "no", never as "yes".
 * 2. Ownership is registered before the awaits, not after them. `claim()` takes
 *    the lease, `settle()` hands the live tunnel over, and a claim that was
 *    released, expired or superseded while attach was in flight loses: its
 *    transport is closed instead of running on unowned.
 * 3. A lease with a live tunnel that still passes every check is renewed rather
 *    than killed at its TTL, so reading a page for an hour is not an error. The
 *    renewal is bounded by the same checks -- and by the device grant's own
 *    expiry, which the authority port reads -- so nothing here is immortal.
 */

import { randomUUID } from 'node:crypto';

export type PreviewSurfaceKind = 'browser';

/**
 * How this endpoint was chosen.
 *
 * `developer`: an operator typed a loopback port inside muxr's own chrome. It
 * reaches anything listening on this machine, so it stays a named diagnostic
 * operation rather than something a product path can reach for.
 * `product`: a capability provider registered the endpoint for a context. The
 * provider is an opaque id validated against the catalog snapshot -- this
 * kernel records one, it never names one.
 */
export type PreviewLeaseAccess = 'developer' | 'product';

export interface PreviewLease {
    id: string;
    machineId: string;
    deviceId: string;
    kind: PreviewSurfaceKind;
    access: PreviewLeaseAccess;
    /** Loopback endpoint on this machine. */
    port: number;
    /** Capability provider that registered the endpoint. Product access only. */
    provider?: string;
    /** Worktree or working directory the surface belongs to. Product access only. */
    context?: string;
    /** Plugin catalog digest this lease was issued under. */
    snapshot: string;
    /**
     * Exact offer generation this product lease is bound to. A lease names
     * one handle at one revision: the offer it was issued from. Replace,
     * close, expiry, or revocation of that generation ends the lease --
     * promptly, through every standing check -- instead of surviving on a
     * sampled snapshot. Absent on developer leases, which bind a typed port.
     */
    offerHandle?: string;
    offerRevision?: number;
    offerSession?: string;
    /**
     * Endpoint process generation this product lease was issued against. A
     * dev server that restarted behind the same port moves it, and the
     * gateway admits nothing for this lease on the new process.
     */
    endpointGeneration?: number;
    issuedAt: number;
    expiresAt: number;
    /**
     * Last device-authenticated touch (issue, resolve, claim, settle, hold,
     * renew). Renewal of an offer-bound lease additionally requires recent
     * presence: a live tunnel alone is holder existence, not liveness.
     */
    seenAt: number;
}

/** Ownership of a lease taken before an attach starts awaiting. */
export interface PreviewLeaseClaim {
    id: string;
    deviceId: string;
    generation: number;
}

export interface PreviewLeaseIssue {
    deviceId: string;
    kind: PreviewSurfaceKind;
    access: PreviewLeaseAccess;
    port: number;
    provider?: string;
    context?: string;
    snapshot: string;
    /** Exact offer generation a product lease binds. Refused when stale. */
    offerHandle?: string;
    offerRevision?: number;
    offerSession?: string;
    endpointGeneration?: number;
}

export interface PreviewLeaseRegistry {
    issue(input: PreviewLeaseIssue): PreviewLease;
    /**
     * Approval authority for (device, provider) is being mutated right now:
     * end every current holder standing on it, synchronously, in this
     * event turn. Only current lease objects end -- there is no stale
     * capture here to guard, and nothing issued afterwards is touched.
     * Other devices and other providers are untouched.
     */
    invalidateAuthority(deviceId: string, provider: string): void;
    /**
     * The catalog identity of a named provider is no longer trustworthy:
     * end every current product holder standing on it, on every device,
     * synchronously. Guarded by lease and holder generation like every end.
     */
    invalidateProvider(provider: string): void;
    /** Throws unless this device may still reach this endpoint right now. */
    resolve(id: string, deviceId: string): PreviewLease;
    /**
     * Take the lease for an attach that is about to await. Throws exactly as
     * `resolve` does, and supersedes any claim or tunnel already on it.
     */
    claim(id: string, deviceId: string): PreviewLease & PreviewLeaseClaim;
    /**
     * Hand a live tunnel to a claim. `false` means the lease was released,
     * expired, lost its standing or was superseded while attach was in flight:
     * the caller owns the transport and must close it.
     */
    settle(claim: PreviewLeaseClaim, close: () => void): boolean;
    /** Attach a live tunnel's closer so expiry and revocation can end it. */
    hold(id: string, close: () => void): void;
    /** A tunnel that died on its own. Ends the lease only if it still holds it. */
    releaseHeld(id: string, close: () => void): void;
    release(id: string, deviceId?: string): void;
    /** Cheap standing check: expiry and device authority. */
    sweep(): void;
    /**
     * Standing without presence, for the gateway and post-attach rechecks.
     * Same checks as the internal standing predicate, but never touches the
     * lease: gateway traffic is not an authenticated device exchange.
     */
    stands(id: string, deviceId: string): boolean;
    /**
     * Live standing without presence: `stands` plus the current
     * exact-device provider approval and the current live Herdr session
     * generation, both re-read now rather than from any timer cache. A
     * revoked approval or a terminated/replaced session answers false
     * immediately -- the gateway refuses the request or upgrade in front
     * of it with zero upstream dials. Never touches the lease and never
     * ends it: ending stays with sweep, revalidate, and renew. Fail
     * closed on anything unreadable.
     */
    standsLive(id: string, deviceId: string): Promise<boolean>;
    /** Full standing check: sweep, catalog snapshot, then renew live tunnels. */
    revalidate(): Promise<void>;
    dispose(): void;
    /** Live leases, for tests and diagnostics. Never user-visible copy. */
    size(): number;
    /**
     * Authenticated renewal from the holding device. Re-resolves the exact
     * offer generation, re-reads the approval snapshot, and extends the
     * lease (and, through `onRenew`, the bound offer) on success. Throws
     * fail-closed otherwise. Calls inside half a TTL of a live expiry
     * return the lease unchanged, which bounds renewal chatter.
     */
    renew(id: string, deviceId: string): Promise<PreviewLease>;
}

const DEFAULT_TTL_MS = 10 * 60_000;
/**
 * Authority is cheap to re-read, so it is re-read every second: a revoked
 * device's live tunnel closes about as fast as the revocation is written.
 */
const SWEEP_MS = 1_000;
/** The catalog costs a plugin listing, so it is re-read less often. */
const SNAPSHOT_MS = 10_000;
const MAX_PER_DEVICE = 4;
const MAX_TOTAL = 16;
/**
 * Offer-bound leases renew only while the holder proved presence recently.
 * The device renews explicitly on a bounded schedule while its surface is
 * mounted; attaches and resolves also touch. Past this window with no
 * authenticated touch, the lease runs out on its TTL even if its tunnel
 * object still exists. Developer leases keep holder-based renewal.
 */
const LIVENESS_MS = 15 * 60_000;

export interface PreviewLeasePorts {
    machineId: string;
    /**
     * Whether this device holds an explicitly live, unexpired, permitted grant
     * right now. Absent authority is not authority: this must answer `false`
     * for a device it has no record of, and a throw is read as `false` too.
     */
    authorized: (deviceId: string) => boolean;
    /**
     * The catalog digest this lease would be issued under today. A digest that
     * no longer matches, or a read that fails, ends the lease and its tunnel.
     */
    snapshot?: (lease: PreviewLease) => Promise<string>;
    /**
     * Whether the exact agent session a product lease names is still a live
     * Herdr session right now. The stored offer record alone cannot answer
     * this: session termination or replacement does not rewrite that
     * record. Read on every live standing check; a terminated session ends
     * the lease and its holder. A herd that cannot be read right now
     * (Herdr disconnected) answers false: fail closed -- standing is
     * denied, existing holders end, renewal is refused -- and a fresh
     * attach reconciles once the herd is readable. Cached disconnected
     * state authorizes nothing. Absent in unit tests, where the session
     * binding is checked against the offer record alone.
     */
    sessionLive?: (sessionId: string) => Promise<boolean>;
    /**
     * Synchronous monotonic authority token for this lease: it changes
     * whenever the owners of exact-device provider approval, the catalog,
     * or the exact session's authority mutate or reconcile that state
     * (approval writes, catalog invalidation, session removal or status
     * change, tree reconciliation) -- and whenever a read observes a
     * change. Captured before the asynchronous reads and compared
     * synchronously immediately before use: any change in between denies
     * without a dial, extension, or a stale end. Absent in unit tests
     * without an authority owner.
     */
    authorityRevision?: (lease: PreviewLease) => string | undefined;
    /**
     * Whether an exact offer handle is still the current live record, at which
     * revision, and in which live agent session. A replace, close, or expiry
     * answers undefined: the bound lease can no longer stand. A live record
     * in a different session than the lease names also ends the lease: the
     * session generation is part of the binding, not a hint. Read on every
     * standing check, so an offer change tears down held leases promptly
     * instead of waiting out a loose catalog sample.
     */
    offerCurrent?: (handle: string) => { revision: number; sessionId?: string | undefined } | undefined;
    /**
     * A held lease that passed every check and was renewed. The host uses it
     * to renew the bound offer alongside the lease, so a live surface never
     * watches its offer expire underneath it.
     */
    onRenew?: (lease: PreviewLease) => void;
    ttlMs?: number;
    sweepMs?: number;
    snapshotMs?: number;
    now?: () => number;
}

/** `pluginId:manifestHash` entries joined by `|`, as the dispatcher builds them. */
function snapshotHasProvider(snapshot: string, provider: string): boolean {
    // An empty id would otherwise match an empty catalog, which is a validator
    // that says yes to nothing being installed.
    if (provider === '') return false;
    return snapshot.split('|').some((entry) => entry.slice(0, entry.lastIndexOf(':')) === provider);
}

/**
 * The exact provider's identity inside a catalog digest: its
 * `pluginId:manifestHash` entry, or undefined when it is not approved
 * there. A product lease stands on this identity alone, so an unrelated
 * plugin's enable, revoke, or manifest change never moves it, while its
 * own approval or manifest change does.
 */
export function providerIdentity(snapshot: string, provider: string): string | undefined {
    if (provider === '') return undefined;
    return snapshot.split('|').find((entry) => entry.slice(0, entry.lastIndexOf(':')) === provider);
}

/**
 * Whether a lease still stands under a freshly read digest: the exact
 * selected provider's identity for product leases, the whole digest for
 * providerless (developer) leases.
 */
function standsUnder(lease: PreviewLease, current: string): boolean {
    if (lease.provider === undefined) return current === lease.snapshot;
    const identity = providerIdentity(current, lease.provider);
    return identity !== undefined && identity === providerIdentity(lease.snapshot, lease.provider);
}

export function createPreviewLeases(ports: PreviewLeasePorts): PreviewLeaseRegistry {
    const now = ports.now ?? Date.now;
    const ttl = ports.ttlMs ?? DEFAULT_TTL_MS;
    const snapshotMs = ports.snapshotMs ?? SNAPSHOT_MS;
    const leases = new Map<string, PreviewLease>();
    const holders = new Map<string, () => void>();
    const generations = new Map<string, number>();
    let lastSnapshotAt = 0;
    let revalidating = false;

    /** Fail closed: an authority port that throws has not said yes. */
    const permitted = (deviceId: string): boolean => {
        try {
            return ports.authorized(deviceId) === true;
        } catch {
            return false;
        }
    };

    const end = (id: string): void => {
        leases.delete(id);
        generations.delete(id);
        const close = holders.get(id);
        holders.delete(id);
        close?.();
    };

    /** A device-authenticated touch: this holder is still present. */
    const touch = (lease: PreviewLease): void => {
        lease.seenAt = now();
    };

    /** Everything checkable without reading the catalog. */
    const standing = (lease: PreviewLease): boolean => {
        if (!(lease.expiresAt > now()) || lease.machineId !== ports.machineId || !permitted(lease.deviceId)) {
            return false;
        }
        // Product leases stand only while their exact offer generation is
        // still current, in the exact live session they were issued for.
        // Replace, close, expiry, and a session that moved on each end the
        // lease -- and the tunnel it holds -- on the next check, which runs
        // at second cadence plus every resolve, claim, settle, and renew.
        if (lease.offerHandle !== undefined) {
            const bound = ports.offerCurrent?.(lease.offerHandle);
            if (bound === undefined || bound.revision !== lease.offerRevision) return false;
            if (lease.offerSession !== undefined && bound.sessionId !== lease.offerSession) return false;
        }
        return true;
    };

    /**
     * Standing without presence: same checks as `standing`, but never touches
     * the lease. The gateway calls this per request and per upgrade -- an
     * admitted subresource is not an authenticated device exchange and must
     * not extend liveness -- and the dispatcher calls it after async attach
     * work. Fail closed on anything unreadable.
     */
    const stands = (id: string, deviceId: string): boolean => {
        try {
            const lease = leases.get(id);
            if (lease === undefined || lease.deviceId !== deviceId) return false;
            return standing(lease);
        } catch {
            return false;
        }
    };

    /**
     * The exact-device provider approval standing right now: the live
     * catalog digest must still match the lease's own, and the lease's
     * provider must still be approved in it. A read that fails counts as
     * "no", never as "yes". Skipped when the registry has no snapshot
     * port (unit tests without a catalog).
     */
    const approvalStands = async (lease: PreviewLease): Promise<boolean> => {
        if (ports.snapshot === undefined) return true;
        let current: string;
        try {
            current = await ports.snapshot(lease);
        } catch {
            return false;
        }
        return standsUnder(lease, current);
    };

    /**
     * The live Herdr session generation standing right now: a product
     * lease naming a session stands only while that session is still
     * live in the herd. Skipped when the registry has no session port
     * (unit tests without a herd).
     */
    const sessionStands = async (lease: PreviewLease): Promise<boolean> => {
        if (lease.offerSession === undefined || ports.sessionLive === undefined) return true;
        try {
            return await ports.sessionLive(lease.offerSession) === true;
        } catch {
            return false;
        }
    };

    /**
     * Guarded end: closes this exact lease object under this exact holder
     * generation and nothing else. Every asynchronous negative -- a
     * failed read, an exception, a delayed result -- routes through here,
     * so stale work can never end a successor holder that settled while
     * it was awaiting.
     */
    const endIfCurrent = (id: string, lease: PreviewLease, generation: number | undefined): void => {
        try {
            if (leases.get(id) === lease && generations.get(id) === generation) end(id);
        } catch {
            /* ending is best effort */
        }
    };

    /** The authority token right now; a registry without an owner port never moves. */
    const revision = (lease: PreviewLease): string | undefined => {
        try {
            if (ports.authorityRevision === undefined) return '';
            return ports.authorityRevision(lease);
        } catch {
            return undefined;
        }
    };
    /** Same captured token, defined at both ends: undefined means authority is in flux -- deny. */
    const tokenHolds = (lease: PreviewLease, token: string | undefined): boolean =>
        token !== undefined && revision(lease) === token;

    /**
     * Live authority: approval and session read together. What the reads
     * cannot see -- a change landing after they answered -- the authority
     * token can: it moves synchronously when the owner mutates, so the
     * comparison after the last await closes the window the reads leave.
     */
    const authorityRound = async (lease: PreviewLease): Promise<boolean> => {
        const [approval, session] = await Promise.all([approvalStands(lease), sessionStands(lease)]);
        return approval && session;
    };

    /**
     * Synchronous final standing, no awaits after it: current lease
     * object, current holder generation, unexpired, exact device still
     * authorized, exact offer generation and session still bound.
     * `stale` means superseded (return false, end nothing); `dead` means
     * this holder's own authority lapsed (end it); `ok` means dial.
     */
    const finalStanding = (id: string, lease: PreviewLease, generation: number | undefined): 'ok' | 'stale' | 'dead' => {
        if (leases.get(id) !== lease || generations.get(id) !== generation) return 'stale';
        if (!(lease.expiresAt > now())) return 'dead';
        if (!permitted(lease.deviceId)) return 'dead';
        if (lease.offerHandle !== undefined) {
            const bound = ports.offerCurrent?.(lease.offerHandle);
            if (bound === undefined || bound.revision !== lease.offerRevision) return 'dead';
            if (lease.offerSession !== undefined && bound.sessionId !== lease.offerSession) return 'dead';
        }
        return 'ok';
    };

    const standsLive = async (id: string, deviceId: string): Promise<boolean> => {
        const lease = leases.get(id);
        if (lease === undefined || lease.deviceId !== deviceId) return false;
        // Ownership generation before the awaits: a claim, release, or
        // retry that lands mid-read must fail the read rather than
        // bless a superseded holder -- and every invalidation below is
        // guarded by this generation, so it never ends a successor.
        const generation = generations.get(id);
        const invalidate = (): void => endIfCurrent(id, lease, generation);
        try {
            if (!standing(lease)) {
                invalidate();
                return false;
            }
            // Capture the authority token, read live, then compare the
            // token synchronously: a revocation or session change that
            // the owner recorded during either await moves the token and
            // this check answers false -- zero dial, nothing ended; the
            // next check reads the owner's new state fresh.
            const token = revision(lease);
            if (token === undefined) return false;
            if (!(await authorityRound(lease))) {
                // Revoked, dead, or unreadable authority is fail closed:
                // the holder ends now rather than forwarding private
                // bytes under standing nobody can confirm.
                invalidate();
                return false;
            }
            const verdict = finalStanding(id, lease, generation);
            if (verdict === 'stale') return false;
            if (verdict === 'dead') {
                invalidate();
                return false;
            }
            if (tokenHolds(lease, token)) return true;
            // The owner moved the token during the reads: this request is
            // denied regardless. One more read decides only whether this
            // exact holder is now dead -- guarded by lease and generation,
            // so it ends nothing but itself.
            if (!(await authorityRound(lease)) || finalStanding(id, lease, generation) === 'dead') invalidate();
            return false;
        } catch {
            invalidate();
            return false;
        }
    };

    const registry: PreviewLeaseRegistry = {
        invalidateAuthority(deviceId, provider) {
            for (const lease of [...leases.values()]) {
                if (lease.deviceId !== deviceId || lease.provider !== provider) continue;
                endIfCurrent(lease.id, lease, generations.get(lease.id));
            }
        },

        invalidateProvider(provider) {
            for (const lease of [...leases.values()]) {
                if (lease.provider !== provider) continue;
                endIfCurrent(lease.id, lease, generations.get(lease.id));
            }
        },

        issue(input) {
            if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
                throw new Error('preview: that is not a port on this machine');
            }
            if (input.kind !== 'browser') throw new Error('preview: unknown surface kind');
            // Neither arm may be skipped by a value the type says cannot exist:
            // these params arrive over the wire.
            if (input.access !== 'developer' && input.access !== 'product') {
                throw new Error('preview: unknown surface access');
            }
            if (input.access === 'developer' && (input.provider !== undefined || input.context !== undefined)) {
                throw new Error('preview: a developer surface names no provider or context');
            }
            if (input.access === 'product') {
                if (input.provider === undefined || input.provider === ''
                    || input.context === undefined || input.context === '') {
                    throw new Error('preview: a surface needs the provider and context it belongs to');
                }
                if (!snapshotHasProvider(input.snapshot, input.provider)) {
                    throw new Error('preview: that surface provider is not enabled on this computer');
                }
            }
            if (!permitted(input.deviceId)) throw new Error('preview: this device may not open a surface');
            registry.sweep();
            const mine = [...leases.values()].filter((lease) => lease.deviceId === input.deviceId);
            if (mine.length >= MAX_PER_DEVICE || leases.size >= MAX_TOTAL) {
                throw new Error('preview: too many open surfaces; close one and try again');
            }
            const at = now();
            const lease: PreviewLease = {
                id: `pvl_${randomUUID()}`,
                machineId: ports.machineId,
                deviceId: input.deviceId,
                kind: input.kind,
                access: input.access,
                port: input.port,
                ...(input.provider === undefined ? {} : { provider: input.provider }),
                ...(input.context === undefined ? {} : { context: input.context }),
                snapshot: input.snapshot,
                ...(input.offerHandle === undefined ? {} : { offerHandle: input.offerHandle }),
                ...(input.offerRevision === undefined ? {} : { offerRevision: input.offerRevision }),
                ...(input.offerSession === undefined ? {} : { offerSession: input.offerSession }),
                ...(input.endpointGeneration === undefined ? {} : { endpointGeneration: input.endpointGeneration }),
                issuedAt: at,
                expiresAt: at + ttl,
                seenAt: at,
            };
            leases.set(lease.id, lease);
            return lease;
        },

        resolve(id, deviceId) {
            const lease = leases.get(id);
            if (lease === undefined) throw new Error('preview: this surface lease is unknown or has expired');
            if (lease.expiresAt <= now()) {
                end(id);
                throw new Error('preview: this surface lease is unknown or has expired');
            }
            if (lease.deviceId !== deviceId) throw new Error('preview: this surface lease belongs to another device');
            if (lease.machineId !== ports.machineId) throw new Error('preview: this surface lease belongs to another computer');
            if (!permitted(deviceId)) {
                end(id);
                throw new Error('preview: this device may not open a surface');
            }
            // A product lease is its offer generation: resolve is the dial
            // path (claim calls it), so a replaced, closed, or expired offer
            // refuses the dial here rather than surviving to attach.
            if (lease.offerHandle !== undefined) {
                const bound = ports.offerCurrent?.(lease.offerHandle);
                if (bound === undefined || bound.revision !== lease.offerRevision) {
                    end(id);
                    throw new Error('preview: that surface is no longer open; open it again');
                }
            }
            touch(lease);
            return lease;
        },

        claim(id, deviceId) {
            const lease = registry.resolve(id, deviceId);
            const generation = (generations.get(lease.id) ?? 0) + 1;
            generations.set(lease.id, generation);
            // One live tunnel per lease. A retry or a second attach supersedes
            // the older one here rather than leaving two listeners behind.
            const previous = holders.get(lease.id);
            if (previous !== undefined) {
                holders.delete(lease.id);
                previous();
            }
            return { ...lease, deviceId, generation };
        },

        settle(claim, close) {
            if (generations.get(claim.id) !== claim.generation) return false;
            const lease = leases.get(claim.id);
            if (lease === undefined || lease.deviceId !== claim.deviceId) return false;
            if (!standing(lease)) {
                end(claim.id);
                return false;
            }
            registry.hold(claim.id, close);
            return true;
        },

        hold(id, close) {
            if (!leases.has(id)) return;
            const lease = leases.get(id);
            if (lease !== undefined) touch(lease);
            const previous = holders.get(id);
            holders.set(id, close);
            if (previous !== undefined && previous !== close) previous();
        },

        releaseHeld(id, close) {
            if (holders.get(id) !== close) return;
            end(id);
        },

        release(id, deviceId) {
            const lease = leases.get(id);
            if (lease !== undefined && deviceId !== undefined && lease.deviceId !== deviceId) return;
            end(id);
        },

        sweep() {
            for (const lease of [...leases.values()]) {
                if (!standing(lease)) end(lease.id);
            }
        },

        stands(id: string, deviceId: string): boolean {
            return stands(id, deviceId);
        },

        async standsLive(id: string, deviceId: string): Promise<boolean> {
            return standsLive(id, deviceId);
        },

        async revalidate() {
            registry.sweep();
            const at = now();
            const recheckCatalog = ports.snapshot !== undefined && at - lastSnapshotAt >= snapshotMs;
            if (recheckCatalog) lastSnapshotAt = at;
            for (const lease of [...leases.values()]) {
                // Every end after an await is guarded by the lease object
                // and the holder generation captured here: a successor
                // that claimed during the read is never ended by it.
                const generation = generations.get(lease.id);
                const endStale = (): void => endIfCurrent(lease.id, lease, generation);
                // Token before the first authority read: a revocation
                // during the catalog await must not become the baseline.
                // Fenced or unreadable authority closes this exact holder
                // now: an approval mutation in flight -- however long its
                // persistence takes -- must stop established forwarding,
                // not merely skip a round. Guarded by lease and holder
                // generation, so a successor is never closed by it.
                const token = revision(lease);
                if (token === undefined) {
                    endStale();
                    continue;
                }
                if (recheckCatalog) {
                    let current: string;
                    try {
                        current = await ports.snapshot!(lease);
                    } catch {
                        // A catalog this host cannot read is not an empty
                        // catalog: it is a lease that can no longer be stood
                        // behind. Close it.
                        endStale();
                        continue;
                    }
                    if (!standsUnder(lease, current)) {
                        endStale();
                        continue;
                    }
                }
                // Awaiting the catalog gave expiry and revocation a window.
                if (!leases.has(lease.id) || !standing(lease)) {
                    endStale();
                    continue;
                }
                // The live session generation is read on every revalidate,
                // not from the stored offer record: a session the herd has
                // terminated or replaced ends the lease and its holder
                // here, within about a second, rather than surviving on a
                // record termination never rewrites. Unreadable is fail
                // closed too: no private bytes forward under standing the
                // herd cannot confirm; a fresh attach reconciles later.
                if (!(await sessionStands(lease))) {
                    endStale();
                    continue;
                }
                // After the final await: superseded work extends nothing,
                // lapsed standing (expiry, device revocation, offer
                // change) ends this holder, and a moved authority token
                // extends nothing -- the next revalidate reads fresh.
                const verdict = finalStanding(lease.id, lease, generation);
                if (verdict === 'stale') continue;
                if (verdict === 'dead') {
                    endStale();
                    continue;
                }
                if (!tokenHolds(lease, token)) continue;
                // A tunnel that is up and still stands renews -- but an
                // offer-bound lease only while its holder proved presence
                // recently through an authenticated device exchange
                // (issue, resolve, claim, or renew). The holder timer here
                // never touches: a live tunnel object alone is holder
                // existence, not liveness. Past the window with no device
                // touch, the lease runs out on its TTL and the tunnel goes
                // with it. One that is not held runs out on its own TTL, so
                // an abandoned lease still dies. Renewal extends the expiry
                // and re-emits the bound offer through `onRenew`, which is
                // state only -- never an executable browser command.
                if (holders.has(lease.id) && lease.expiresAt - now() < ttl / 2
                    && (lease.offerHandle === undefined || now() - lease.seenAt <= LIVENESS_MS)) {
                    lease.expiresAt = now() + ttl;
                    ports.onRenew?.(lease);
                }
            }
        },

        async renew(id: string, deviceId: string): Promise<PreviewLease> {
            const lease = registry.resolve(id, deviceId);
            if (lease.offerHandle === undefined) {
                throw new Error('preview: developer leases renew while held');
            }
            const generation = generations.get(id);
            const endStale = (): void => endIfCurrent(id, lease, generation);
            // Token before the first authority read; in-flux authority
            // denies renewal without ending anything.
            const token = revision(lease);
            if (token === undefined) throw new Error('preview: that surface is no longer open; open it again');
            // Exact receiving-device approval on every renew, before the
            // bounded early return: a revoked provider refuses even a lease
            // far from expiry. The read throws fail-closed; a changed or
            // unreadable catalog ends the lease and its tunnel.
            if (ports.snapshot !== undefined) {
                let current: string;
                try {
                    current = await ports.snapshot(lease);
                } catch {
                    endStale();
                    throw new Error('preview: this host cannot read its plugin catalog');
                }
                if (!standsUnder(lease, current)) {
                    endStale();
                    throw new Error('preview: that surface provider is not approved on this device');
                }
            }
            // The catalog read awaited: recheck exact offer/session standing
            // after it, the same as every other async boundary -- plus the
            // live herd generation, which no stored record can prove. An
            // unreadable herd denies renewal and ends the holder: cached
            // disconnected state authorizes nothing.
            if (!leases.has(id) || !standing(lease) || !(await sessionStands(lease))) {
                endStale();
                throw new Error('preview: that surface is no longer open; open it again');
            }
            // After the final await, synchronously: device revocation,
            // expiry, or an offer change during the reads ends this
            // holder and extends nothing; superseded work extends
            // nothing; a moved authority token extends nothing either --
            // the holder renews again once the owner's state is read.
            const verdict = finalStanding(id, lease, generation);
            if (verdict === 'dead') {
                endStale();
                throw new Error('preview: that surface is no longer open; open it again');
            }
            if (verdict === 'stale' || !tokenHolds(lease, token)) {
                throw new Error('preview: that surface is no longer open; open it again');
            }
            // Bounded: a lease far from expiry reports its standing without
            // doing renewal work.
            if (lease.expiresAt - now() > ttl / 2) return lease;
            lease.expiresAt = now() + ttl;
            touch(lease);
            ports.onRenew?.(lease);
            return lease;
        },

        dispose() {
            clearInterval(timer);
            for (const id of [...leases.keys()]) end(id);
        },

        size() {
            return leases.size;
        },
    };

    const timer = setInterval(() => {
        // Authority is cheap and must land within about a second, so it never
        // waits behind a catalog read that is slow, hung, or already running.
        registry.sweep();
        if (revalidating) return;
        revalidating = true;
        void registry.revalidate().finally(() => { revalidating = false; });
    }, ports.sweepMs ?? SWEEP_MS);
    timer.unref?.();
    return registry;
}
