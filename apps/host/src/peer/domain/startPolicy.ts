import type { ClientRequest, PeerCapability } from '@trymuxr/contract';

export interface PeerDeviceContext {
    kind: 'native' | 'browser' | 'peer';
    capabilities?: readonly PeerCapability[];
    allowedCwds?: readonly string[];
}

export function peerStartUsesUnapprovedOptions(params: {
    parentSessionId?: unknown;
    createCwd?: unknown;
    worktree?: unknown;
    kinds?: unknown;
    /** A peer machine may never pick this host's sign-in. */
    planAccount?: unknown;
}): boolean {
    if (params.parentSessionId !== undefined) return true;
    if (params.createCwd !== undefined) return true;
    if (params.worktree !== undefined) return true;
    if (params.kinds !== undefined) return true;
    if (params.planAccount !== undefined) return true;
    return false;
}

export function peerRequestRequiresMutationReceipt(
    request: ClientRequest,
): request is Extract<ClientRequest, { type: 'session.prompt' | 'session.start' | 'agent.watch' }> {
    return request.type === 'session.prompt' || request.type === 'session.start' || request.type === 'agent.watch';
}

export function peerGrantAllowsRequest(
    kind: string,
    capability: string | undefined,
    capabilities: readonly string[] | undefined,
): boolean {
    if (kind !== 'peer') return false;
    if (capability === undefined) return false;
    if (capabilities === undefined) return false;
    return capabilities.includes(capability);
}
