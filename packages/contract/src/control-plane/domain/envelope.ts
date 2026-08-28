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
import { isValidPluginId } from '../../plugins/index.js';

/**
 * Close code the relay sends to a machine peer it retires because a newer host
 * connected for the same machineId. The retired host must not reconnect.
 */
export const RELAY_CLOSE_REPLACED = 4000;

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
    | RequestResponse;

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
