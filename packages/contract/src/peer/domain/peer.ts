/** Narrow host-to-host authority shared by self-hosted and hosted control planes. */

import { fail, ok, type Outcome } from '../../shared/outcome.js';

export const PEER_CAPABILITIES = ['list', 'read', 'status', 'watch', 'prompt', 'start'] as const;
export const DEFAULT_PEER_CAPABILITIES = PEER_CAPABILITIES.slice(0, 5) as readonly PeerCapability[];
/** Producer validity window. Kept below the target maximum for bounded clock skew. */
export const PEER_MUTATION_TTL_MS = 4 * 60_000;
/** Hard target-side limit for untrusted mutation metadata. */
export const PEER_MUTATION_MAX_TTL_MS = 5 * 60_000;
/** Maximum accepted positive producer clock skew for legacy clients at the hard TTL. */
export const PEER_MUTATION_CLOCK_SKEW_MS = 30_000;

export type PeerCapability = (typeof PEER_CAPABILITIES)[number];
export type DeviceKind = 'native' | 'browser' | 'peer';

export function parseDeviceKind(value: unknown): Outcome<DeviceKind> {
    if (value !== 'native' && value !== 'browser' && value !== 'peer') return fail('grant: invalid device kind');
    return ok(value);
}

export interface PeerMutationMetadata {
    /** Stable across retries; the target persists the first result until expiry. */
    operationId: string;
    /** Epoch ms. Targets reject the mutation before dispatch after this time. */
    notValidAfter: number;
}

export interface PeerDescriptorClaims {
    v: 1;
    sourceMachineId: string;
    sourceMachineSigningPublicKey: string;
    targetMachineId: string;
    targetMachineSigningPublicKey: string;
    peerPublicKey: string;
    preparedAt: number;
    expiresAt: number;
    nonce: string;
    sourceName?: string;
    sourcePlatform?: string;
}

export interface SignedPeerDescriptor {
    v: 1;
    claims: PeerDescriptorClaims;
    /** Detached ed25519 signature over the domain-separated canonical claims. */
    signature: string;
}

/** Optional hosted fields; self-hosted authorities may omit every field. */
export interface PeerAuthorityMetadata {
    authorityId?: string;
    credentialExpiresAt?: number;
    refreshAfter?: number;
    region?: string;
}

export type PeerRelationshipState = 'pending' | 'connected' | 'repair-needed' | 'disconnecting' | 'revoked';

export interface PeerRelationship {
    relationshipId: string;
    direction: 'inbound' | 'outbound';
    machineId: string;
    machineName?: string;
    platform?: string;
    state: PeerRelationshipState;
    capabilities: PeerCapability[];
    peerDeviceId?: string;
    createdAt: number;
    updatedAt: number;
    keyVersion?: number;
    authority?: PeerAuthorityMetadata;
}

export function isPeerCapabilities(value: unknown): value is PeerCapability[] {
    return Array.isArray(value)
        && value.length > 0
        && value.length <= PEER_CAPABILITIES.length
        && new Set(value).size === value.length
        && value.every((capability) => typeof capability === 'string'
            && (PEER_CAPABILITIES as readonly string[]).includes(capability));
}

export function parsePeerAllowlist(value: unknown): Outcome<PeerCapability[]> {
    if (!isPeerCapabilities(value)) return fail('invalid peer capabilities');
    return ok(value);
}

/** The complete peer-dispatch allowlist. Undefined means a peer must be denied. */
export function peerCapabilityForRequest(type: string): PeerCapability | undefined {
    switch (type) {
        case 'machines.list':
        case 'session.list':
        case 'herdr.tree':
        case 'herdr.agentKinds':
            return 'list';
        case 'pane.read':
            return 'read';
        case 'session.status':
            return 'status';
        case 'agent.watch':
            return 'watch';
        case 'session.prompt':
            return 'prompt';
        case 'session.start':
            return 'start';
        default:
            return undefined;
    }
}

export function peerMayDispatch(allowlist: readonly PeerCapability[], requestType: string): boolean {
    const needed = peerCapabilityForRequest(requestType);
    if (needed === undefined) return false;
    return allowlist.includes(needed);
}

export type PeerMutationRejection = 'invalid' | 'expired' | 'window-too-long';

export function inspectPeerMutation(value: unknown, now: number): Outcome<PeerMutationMetadata, PeerMutationRejection> {
    if (value === null || typeof value !== 'object') return fail('invalid');
    const mutation = value as PeerMutationMetadata;
    if (typeof mutation.operationId !== 'string' || mutation.operationId === '' || mutation.operationId.length > 160
        || !Number.isFinite(mutation.notValidAfter)) {
        return fail('invalid');
    }
    if (mutation.notValidAfter <= now) return fail('expired');
    if (mutation.notValidAfter > now + PEER_MUTATION_MAX_TTL_MS + PEER_MUTATION_CLOCK_SKEW_MS) {
        return fail('window-too-long');
    }
    return ok(mutation);
}

export type PeerGrantConstraintError =
    | 'constraints-on-non-peer'
    | 'missing-capabilities'
    | 'broad-authority'
    | 'missing-start-directories'
    | 'directories-without-start';

function parseStartDirectories(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (value.some((cwd) => typeof cwd !== 'string' || cwd.trim() === '')) return undefined;
    return value as string[];
}

/** Peer Device Grant constraints. Native/browser grants must not carry this shape. */
export function inspectPeerGrantConstraints(input: {
    deviceKind?: DeviceKind;
    authority?: string;
    capabilities?: unknown;
    allowedCwds?: unknown;
}): Outcome<{ capabilities?: PeerCapability[]; allowedCwds?: string[] }, PeerGrantConstraintError> {
    const isPeerDevice = input.deviceKind === 'peer';
    if (!isPeerDevice) {
        if (input.capabilities !== undefined || input.allowedCwds !== undefined) {
            return fail('constraints-on-non-peer');
        }
        return ok({});
    }
    const allowlist = parsePeerAllowlist(input.capabilities);
    if (!allowlist.ok) return fail('missing-capabilities');
    if (input.authority !== undefined) return fail('broad-authority');
    const canStart = allowlist.value.includes('start');
    if (canStart) {
        const directories = parseStartDirectories(input.allowedCwds);
        if (directories === undefined) return fail('missing-start-directories');
        return ok({ capabilities: allowlist.value, allowedCwds: directories });
    }
    if (input.allowedCwds !== undefined) return fail('directories-without-start');
    return ok({ capabilities: allowlist.value });
}
