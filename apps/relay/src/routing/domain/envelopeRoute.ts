export type PeerRouteOutcome = 'delivered' | 'tenant-mismatch' | 'target-unavailable';

export function peerRouteOutcome(delivered: number, sameMachineVisibleToOtherTenant: boolean): PeerRouteOutcome {
    if (delivered > 0) return 'delivered';
    if (sameMachineVisibleToOtherTenant) return 'tenant-mismatch';
    return 'target-unavailable';
}

export function tenantMachineKey(accountId: string, machineId: string): string {
    return `${accountId.length}:${accountId}${machineId}`;
}

export function envelopeTargetRole(fromRole: 'machine' | 'client'): 'machine' | 'client' {
    if (fromRole === 'machine') return 'client';
    return 'machine';
}
