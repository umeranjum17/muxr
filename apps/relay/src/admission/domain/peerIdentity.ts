import type { DeviceKind, PeerCapability } from '@muxr/contract';

/** Narrow ticket shape — everything WS auth needs, no persistence bookkeeping. */
export interface Ticket {
    role: 'machine' | 'client';
    machineSlug: string;
    accountId: string;
    deviceId?: string;
    deviceKind?: DeviceKind;
    capabilities?: PeerCapability[];
    credentialVersion?: number;
    machineCredentialId?: string;
    transport: 'relay' | 'terminal' | 'preview' | 'stream';
    channel?: string;
}

/**
 * Admission to a relay WebSocket. Ticket admission always carries `transport`.
 * Loopback query-string admission (local harness / probe) has no transport and
 * is always in the `local` tenant.
 */
export interface PeerIdentity {
    role: 'machine' | 'client';
    machineIds: ReadonlySet<string>;
    accountId: string;
    deviceId?: string;
    deviceKind?: DeviceKind;
    capabilities?: PeerCapability[];
    credentialVersion?: number;
    machineCredentialId?: string;
    transport?: Ticket['transport'];
    channel?: string;
}

export function admittedByTicket(identity: PeerIdentity): identity is PeerIdentity & { transport: Ticket['transport'] } {
    return identity.transport !== undefined;
}

export function loopbackPeerIdentity(role: 'machine' | 'client', machineIds: ReadonlySet<string>): PeerIdentity {
    return { role, machineIds, accountId: 'local' };
}

export function identityFromTicket(ticket: Ticket): PeerIdentity {
    return {
        role: ticket.role,
        machineIds: new Set([ticket.machineSlug]),
        accountId: ticket.accountId,
        transport: ticket.transport,
        ...(ticket.deviceId === undefined ? {} : { deviceId: ticket.deviceId }),
        ...(ticket.deviceKind === undefined ? {} : { deviceKind: ticket.deviceKind }),
        ...(ticket.capabilities === undefined ? {} : { capabilities: ticket.capabilities }),
        ...(ticket.credentialVersion === undefined ? {} : { credentialVersion: ticket.credentialVersion }),
        ...(ticket.machineCredentialId === undefined ? {} : { machineCredentialId: ticket.machineCredentialId }),
        ...(ticket.channel === undefined ? {} : { channel: ticket.channel }),
    };
}

/** Parse local-development subscriptions. Hosted/strict peers get scope only from a consumed ticket. */
export function parseSubscribedMachineIds(url: URL): string[] {
    const multi = url.searchParams.get('machineIds');
    if (multi !== null && multi.trim() !== '') {
        return [...new Set(multi.split(',').map((part) => part.trim()).filter((part) => part !== ''))];
    }
    const single = url.searchParams.get('machineId')?.trim();
    if (single === undefined || single === '') return [];
    return [single];
}
