import type { PeerClientRequest, PeerRequestResult } from '@muxr/contract';
import type { MachinePendingRotation } from '../../machine/index.js';
import type { StoredPendingAuthorization, StoredPeerRelationship } from '../infrastructure/store.js';

export type RevokePeerAuthorityCommand = Extract<PeerClientRequest, { type: 'peer.revoke' }>['params'];
export type RevokePeerAuthorityResult = PeerRequestResult<'peer.revoke'>;

export interface RevokePeerAuthorityFleet {
    now(): number;
    store: {
        pendingAuthorization(): StoredPendingAuthorization | undefined;
        relationship(relationshipId: string): StoredPeerRelationship | undefined;
        putRelationship(value: StoredPeerRelationship): Promise<void>;
    };
    pendingRotation(): MachinePendingRotation | undefined;
    cancelPendingAuthorization(pending: StoredPendingAuthorization): Promise<RevokePeerAuthorityResult>;
    finishPeerRevocation(pending: MachinePendingRotation): Promise<void>;
    closeOutbound(relationshipId: string): void;
    buildPeerRevocation(relationship: StoredPeerRelationship): MachinePendingRotation;
    fencePeerRevocation(pending: MachinePendingRotation): Promise<void>;
    fail(message: string, code: string): Error;
}

/** Revoke a peer Device Grant. Idempotent. Display names never authorize. */
export async function revokePeerAuthority(
    fleet: RevokePeerAuthorityFleet,
    command: RevokePeerAuthorityCommand,
): Promise<RevokePeerAuthorityResult> {
    const authorization = fleet.store.pendingAuthorization();
    if (authorization?.relationshipId === command.relationshipId) {
        return fleet.cancelPendingAuthorization(authorization);
    }
    const relationship = fleet.store.relationship(command.relationshipId);
    if (relationship === undefined || relationship.state === 'revoked') {
        return { state: 'already-revoked', revokedAt: fleet.now() };
    }
    const recovery = fleet.pendingRotation();
    if (recovery?.kind === 'peer-revoke-v1' && recovery.revokedDeviceId === relationship.peerDeviceId) {
        await fleet.finishPeerRevocation(recovery);
        await fleet.store.putRelationship({ ...relationship, state: 'revoked', updatedAt: fleet.now() });
        return { state: 'revoked', revokedAt: fleet.now(), ...(relationship.authority === undefined ? {} : { authority: relationship.authority }) };
    }
    if (relationship.direction === 'outbound') {
        if (command.peerDeviceId !== relationship.peerDeviceId) {
            throw fleet.fail('target revocation must be confirmed before deleting the outbound bundle', 'peer-revoke-unconfirmed');
        }
        fleet.closeOutbound(relationship.relationshipId);
        const { credential: _credential, peerKey: _peerKey, sealedGrant: _sealedGrant, ...revoked } = relationship;
        await fleet.store.putRelationship({ ...revoked, state: 'revoked', updatedAt: fleet.now() });
        return { state: 'revoked', revokedAt: fleet.now(), ...(relationship.authority === undefined ? {} : { authority: relationship.authority }) };
    }
    if (relationship.peerDeviceId === undefined) throw fleet.fail('peer relationship has no device binding', 'peer-revoke-invalid');
    const pending = fleet.buildPeerRevocation(relationship);
    await fleet.fencePeerRevocation(pending);
    await fleet.store.putRelationship({ ...relationship, state: 'disconnecting', updatedAt: fleet.now() });
    await fleet.finishPeerRevocation(pending);
    await fleet.store.putRelationship({ ...relationship, state: 'revoked', updatedAt: fleet.now() });
    return { state: 'revoked', revokedAt: fleet.now(), ...(relationship.authority === undefined ? {} : { authority: relationship.authority }) };
}
