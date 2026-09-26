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
