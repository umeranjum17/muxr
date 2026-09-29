import type { MachineInfo, SessionEvent, SessionInfo } from '../../herd/index.js';
import type { ClientRequest, RequestResponse } from './requests.js';
import { isValidPluginId } from '../../plugins/index.js';

// --- machine host -> client -------------------------------------------------

export interface PluginsInvalidatedFrame {
    type: 'plugins.invalidated';
    reason: 'linked' | 'unlinked' | 'enabled' | 'disabled' | 'changed';
    pluginIds: string[];
}

export type HostFrame =
    | { type: 'session.event'; sessionId: string; event: SessionEvent }
    | { type: 'session.list'; sessions: SessionInfo[] }
    | ({ type: 'machine.hello' } & MachineHello)
    | { type: 'machine.list'; machines: MachineInfo[] }
    | PluginsInvalidatedFrame
    | RequestResponse;

// --- control protocol --------------------------------------------------------

/**
 * The control protocol the host and the app speak, versioned apart from
 * either release so the two can ship on their own schedules. Each side
 * speaks a contiguous range of protocol versions and they work together
 * while the ranges overlap. Raise `max` when a side learns a new protocol;
 * raise `min` only when it drops an old one.
 */
export interface ProtocolRange { min: number; max: number }

export const CONTROL_PROTOCOL_RANGE: ProtocolRange = { min: 1, max: 1 };
export const CONTROL_PROTOCOL = CONTROL_PROTOCOL_RANGE.max;
/** What a host that predates the handshake speaks. */
const BASELINE_PROTOCOL_RANGE: ProtocolRange = { min: 1, max: 1 };

/** The host's answer to `machine.hello`. */
export interface MachineHello {
    machineId: string;
    hostVersion: string;
    /** The protocol version this host speaks natively. */
    protocol?: number;
    /** Every protocol version this host still serves. */
    capabilityRange?: ProtocolRange;
}

export function machineHello(machineId: string, hostVersion: string): MachineHello {
    return { machineId, hostVersion, protocol: CONTROL_PROTOCOL, capabilityRange: CONTROL_PROTOCOL_RANGE };
}

export type ProtocolCompatibility =
    | { ok: true; protocol: number }
    | { ok: false; reason: 'host-too-old' | 'host-too-new'; host: ProtocolRange };

function protocolVersion(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * Whether this app can talk to a host, from the host's `machine.hello`.
 * A host that omits the fields, or sends ones that do not parse, is an
 * older host and speaks the baseline protocol.
 */
export function checkHostProtocol(hello: unknown, app: ProtocolRange = CONTROL_PROTOCOL_RANGE): ProtocolCompatibility {
    const fields = typeof hello === 'object' && hello !== null ? hello as Record<string, unknown> : {};
    const range = fields.capabilityRange as Record<string, unknown> | undefined;
    let host = BASELINE_PROTOCOL_RANGE;
    if (typeof range === 'object' && range !== null && protocolVersion(range.min) && protocolVersion(range.max) && range.min <= range.max) {
        host = { min: range.min, max: range.max };
    } else if (protocolVersion(fields.protocol)) {
        host = { min: fields.protocol, max: fields.protocol };
    }
    if (host.max < app.min) return { ok: false, reason: 'host-too-old', host };
    if (host.min > app.max) return { ok: false, reason: 'host-too-new', host };
    return { ok: true, protocol: Math.min(host.max, app.max) };
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
