/**
 * Envelope routing.
 *
 * The relay routes `Envelope`s. It reads ONLY the routing header. `payload` is
 * opaque to it -- in production it is ciphertext the relay cannot read, and the
 * relay must never gain a reason to parse it. Every "the relay needs to know
 * about sessions" request is a design error; route it or buffer it, don't parse it.
 */

import type { MachineInfo, SessionEvent, SessionInfo } from '../../herd/index.js';
import type { ClientRequest, RequestResponse } from './requests.js';
import type { SurfaceOffer } from './surface.js';
import { isSurfaceOfferHandle, isSurfaceSessionId, SURFACE_CAPABILITIES } from './surface.js';
import { isValidPluginId } from '../../plugins/index.js';

/**
 * Close code the relay sends to a machine peer it retires because a newer host
 * connected for the same machineId. The retired host must not reconnect.
 */
export const RELAY_CLOSE_REPLACED = 4000;
/**
 * The machine host behind a client's route went away or was replaced. The
 * relay closes the client so it reconnects and negotiates with whatever host
 * answers next, instead of carrying the old host's guarantees to a new one.
 */
export const RELAY_CLOSE_HOST_GONE = 4001;

/**
 * Strict hosted-mode routing channel. The same vocabulary binds relay routing
 * and the E2EE envelope context so those two modules cannot drift.
 */
export const ROUTING_CHANNELS = ['session', 'terminal', 'attachment', 'stream', 'pairing', 'grant'] as const;
export type RoutingChannel = (typeof ROUTING_CHANNELS)[number];

export function isRoutingChannel(value: unknown): value is RoutingChannel {
    return typeof value === 'string' && (ROUTING_CHANNELS as readonly string[]).includes(value);
}

/** Cleartext routing header. The only part the relay is allowed to read. */
export interface EnvelopeHeader {
    /** Which machine the frame is going to / coming from. */
    machineId: string;
    /** Present for session-scoped traffic; absent for machine-scoped. */
    sessionId?: string;
    /** Strict hosted mode: stable identity of the frame sender (machine or device). */
    senderId?: string;
    /** Strict hosted mode: stable identity of the frame recipient (machine or device). */
    recipientId?: string;
    /** Strict hosted mode: routing channel; feeds the v2 envelope context. */
    channel?: RoutingChannel;
    /** Strict hosted mode: session/terminal/attachment/mailbox/grant stream id. */
    streamId?: string;
    /** Strict hosted mode: key version bound into the v2 envelope context. */
    keyVersion?: number;
    /** Monotonic per-connection, for ordering and replay. */
    seq: number;
    /** Epoch ms, set by the sender. */
    at: number;
}

export interface Envelope {
    header: EnvelopeHeader;
    /**
     * Opaque to the relay. Encodes a `HostFrame` or `ClientFrame`.
     * Encrypted in production; plain JSON in local/dev.
     */
    payload: string;
}

/** Hosted Envelopes carry sender, recipient, channel, stream, and key generation. Local/dev omit them. */
export function envelopeIsHosted(header: EnvelopeHeader): header is EnvelopeHeader & {
    senderId: string;
    recipientId: string;
    channel: RoutingChannel;
    streamId: string;
    keyVersion: number;
} {
    return header.senderId !== undefined
        && header.recipientId !== undefined
        && header.channel !== undefined
        && header.streamId !== undefined
        && header.keyVersion !== undefined;
}

// --- machine host -> client -------------------------------------------------

export interface PluginsInvalidatedFrame {
    type: 'plugins.invalidated';
    reason: 'linked' | 'unlinked' | 'enabled' | 'disabled' | 'changed';
    pluginIds: string[];
}

export type HostFrame =
    | { type: 'session.event'; sessionId: string; event: SessionEvent }
    | { type: 'session.list'; sessions: SessionInfo[] }
    | { type: 'machine.hello'; machineId: string; hostVersion: string }
    | { type: 'machine.list'; machines: MachineInfo[] }
    | PluginsInvalidatedFrame
    | SurfaceOfferHostFrame
    | RequestResponse;

/**
 * Host-originated Surface offer: how a phone learns that `muxr browser open`
 * on the host named a target for exactly one live agent session.
 *
 * Emitted on open, update, reload (re-emit, same revision) and close, inside
 * the existing encrypted control plane, directed only at currently
 * control-authorized devices -- never peers, never view-only, revoked or
 * expired grants. The opaque handle and the session id travel here and in
 * `preview.lease` alone; they stay out of CLI and agent output. A phone that
 * reconnects is replayed the current offers; nothing is claimed visible
 * before a device acknowledgement exists.
 */
export interface SurfaceOfferHostFrame {
    type: 'surface.offer';
    operation: 'open' | 'update' | 'reload' | 'close';
    /** Opaque current offer handle. Control-plane only, never displayed. */
    handle: string;
    /** The exact live agent session this offer belongs to. Never displayed. */
    sessionId: string;
    revision: number;
    expiresAt: number;
    /**
     * Monotonic command identity for this logical surface: every open,
     * update, reload, and close advances it. A reload with a command the
     * phone already executed is a duplicate, not an order; a renewal
     * re-emit keeps its command so it never executes. Absent only on
     * frames from hosts that predate commands, which never execute.
     */
    command?: number;
    /** Absent on close: there is nothing to show anymore. */
    offer?: SurfaceOffer;
}

/** Bounded runtime guard for host-originated surface frames. Shape only. */
export function isSurfaceOfferHostFrame(value: unknown): value is SurfaceOfferHostFrame {
    if (typeof value !== 'object' || value === null) return false;
    const frame = value as Record<string, unknown>;
    if (frame.type !== 'surface.offer') return false;
    if (frame.operation !== 'open' && frame.operation !== 'update'
        && frame.operation !== 'reload' && frame.operation !== 'close') return false;
    if (!isSurfaceOfferHandle(frame.handle)) return false;
    if (!isSurfaceSessionId(frame.sessionId)) return false;
    if (typeof frame.revision !== 'number' || !Number.isInteger(frame.revision) || frame.revision < 1) return false;
    if (typeof frame.expiresAt !== 'number' || !Number.isFinite(frame.expiresAt) || frame.expiresAt <= 0) return false;
    if (frame.command !== undefined
        && (typeof frame.command !== 'number' || !Number.isInteger(frame.command) || frame.command < 1)) return false;
    if (frame.operation === 'close') return frame.offer === undefined;
    const offer = frame.offer as Record<string, unknown> | undefined;
    if (typeof offer !== 'object' || offer === null) return false;
    if (offer.version !== 1 || typeof offer.name !== 'string' || typeof offer.title !== 'string') return false;
    if (typeof offer.revision !== 'number' || typeof offer.expiresAt !== 'number') return false;
    if (typeof offer.capability !== 'string'
        || !(SURFACE_CAPABILITIES as readonly string[]).includes(offer.capability)) return false;
    // The mobile admits only when this exact provider is currently approved
    // and still claims the capability, so a frame without one is malformed.
    if (typeof offer.provider !== 'string' || offer.provider === '' || offer.provider.length > 64) return false;
    if (offer.kind !== 'browser-direct' && offer.kind !== 'browser-local' && offer.kind !== 'browser-session' && offer.kind !== 'code-review') return false;
    // `code open` versus `code diff` travels explicitly: the phone must never
    // infer the native destination from a revision string.
    if (offer.kind === 'code-review' && offer.destination !== 'file' && offer.destination !== 'diff') return false;
    // A session offer names its session by opaque handle and shows a bare
    // hostname; anything else in those fields is malformed.
    if (offer.kind === 'browser-session') {
        if (offer.capability !== 'surface.browser.control-host-session') return false;
        if (typeof offer.session !== 'string' || !/^bsn_[A-Za-z0-9_-]{8,128}$/.test(offer.session)) return false;
        if (typeof offer.site !== 'string' || offer.site.length > 253 || (offer.site !== '' && !/^[A-Za-z0-9.-]+$/.test(offer.site))) return false;
    }
    return true;
}

/** Runtime guard for the additive machine frame; malformed peer data is ignored. */
const PLUGIN_INVALIDATION_REASONS = ['linked', 'unlinked', 'enabled', 'disabled', 'changed'] as const;

export function isPluginsInvalidatedFrame(value: unknown): value is PluginsInvalidatedFrame {
    if (typeof value !== 'object' || value === null) return false;
    const frame = value as Record<string, unknown>;
    const isInvalidation = frame.type === 'plugins.invalidated';
    const reasonIsKnown = typeof frame.reason === 'string'
        && (PLUGIN_INVALIDATION_REASONS as readonly string[]).includes(frame.reason);
    const pluginIdsAreBounded = Array.isArray(frame.pluginIds)
        && frame.pluginIds.length <= 32
        && frame.pluginIds.every(isValidPluginId);
    return isInvalidation && reasonIsKnown && pluginIdsAreBounded;
}

// --- client -> machine host -------------------------------------------------

export type ClientFrame = ClientRequest | { type: 'client.hello'; clientId: string };

export function encodePayload(frame: HostFrame | ClientFrame): string {
    return JSON.stringify(frame);
}

export function decodePayload<T extends HostFrame | ClientFrame>(payload: string): T {
    return JSON.parse(payload) as T;
}

let requestCounter = 0;

export function nextRequestId(prefix = 'req'): string {
    requestCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${requestCounter.toString(36)}`;
}
