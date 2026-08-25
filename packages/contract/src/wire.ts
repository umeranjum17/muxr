/**
 * Relay wire format.
 *
 * The relay routes `Envelope`s. It reads ONLY the routing header. `payload` is
 * opaque to it -- in production it is ciphertext the relay cannot read, and the
 * relay must never gain a reason to parse it. Every "the relay needs to know
 * about sessions" request is a design error; route it or buffer it, don't parse it.
 */

import type { SessionEvent } from './sessionEvent.js';
import type { MachineInfo } from './sessionDomain.js';
import type { ClientRequest, RequestResponse } from './requests.js';
import type { SessionInfo } from './sessionState.js';

/**
 * Close code the relay sends to a machine peer it retires because a newer host
 * connected for the same machineId. The retired host must not reconnect.
 */
export const RELAY_CLOSE_REPLACED = 4000;

/**
 * Strict hosted-mode routing channel. Mirrors `V2Channel` in @muxr/crypto so
 * the relay can route without ever parsing `payload`.
 */
export type RoutingChannel = 'session' | 'terminal' | 'attachment' | 'stream' | 'pairing' | 'grant';

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

const EXTENSION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidPluginId(value: unknown): value is string {
    return typeof value === 'string' && EXTENSION_ID.test(value);
}

/** Runtime guard for the additive machine frame; malformed peer data is ignored. */
export function isPluginsInvalidatedFrame(value: unknown): value is PluginsInvalidatedFrame {
    if (typeof value !== 'object' || value === null) return false;
    const frame = value as Record<string, unknown>;
    return frame.type === 'plugins.invalidated'
        && (frame.reason === 'linked' || frame.reason === 'unlinked' || frame.reason === 'enabled' || frame.reason === 'disabled' || frame.reason === 'changed')
        && Array.isArray(frame.pluginIds)
        && frame.pluginIds.length <= 32
        && frame.pluginIds.every(isValidPluginId);
}

// --- client -> machine host -------------------------------------------------

export type ClientFrame = ClientRequest | { type: 'client.hello'; clientId: string };

/** Validate the common client-frame boundary before host code reads request fields. */
export function parseClientFrame(value: unknown): ClientFrame {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('client frame must be an object');
    const frame = value as Record<string, unknown>;
    if (typeof frame.type !== 'string' || frame.type === '' || frame.type.length > 80) throw new Error('client frame type is invalid');
    if (frame.type === 'client.hello') {
        if (typeof frame.clientId !== 'string' || frame.clientId === '' || frame.clientId.length > 160) throw new Error('client hello is invalid');
        return value as ClientFrame;
    }
    if (typeof frame.requestId !== 'string' || frame.requestId === '' || frame.requestId.length > 160
        || typeof frame.params !== 'object' || frame.params === null || Array.isArray(frame.params)) {
        throw new Error('client request shape is invalid');
    }
    return value as ClientFrame;
}

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
