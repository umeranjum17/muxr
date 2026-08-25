/** Narrow host-to-host authority shared by self-hosted and hosted control planes. */

export const PEER_CAPABILITIES = ['list', 'read', 'status', 'watch', 'prompt', 'start'] as const;
export const DEFAULT_PEER_CAPABILITIES = PEER_CAPABILITIES.slice(0, 5) as readonly PeerCapability[];

export type PeerCapability = (typeof PEER_CAPABILITIES)[number];
export type DeviceKind = 'native' | 'browser' | 'peer';

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
