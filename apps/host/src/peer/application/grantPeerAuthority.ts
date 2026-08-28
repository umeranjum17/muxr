import { createHash } from 'node:crypto';
import { isPeerCapabilities, type PeerCapability, type PeerClientRequest, type PeerRequestResult } from '@muxr/contract';
import { verifySignedPeerDescriptor } from '@muxr/crypto';
import { DeviceGrant, type MachineCryptoState } from '../../machine/index.js';
import type { StoredPendingAuthorization, StoredPeerRelationship } from '../infrastructure/store.js';

export type GrantPeerAuthorityCommand = Extract<PeerClientRequest, { type: 'peer.authorize' }>['params'];
export type GrantPeerAuthorityResult = PeerRequestResult<'peer.authorize'>;

export interface GrantPeerAuthorityFleet {
    now(): number;
    machineId: string;
    relayUrl: string;
    readyCrypto(): MachineCryptoState;
    store: {
        authorization(descriptorHash: string): StoredPeerRelationship | undefined;
        pendingAuthorization(): StoredPendingAuthorization | undefined;
        relationship(relationshipId: string): StoredPeerRelationship | undefined;
        putPendingAuthorization(value: StoredPendingAuthorization | undefined): Promise<void>;
    };
    validateStartDirectories(capabilities: readonly PeerCapability[], value: string[] | undefined): string[] | undefined;
    repairOrphanDevices(): Promise<void>;
    canonicalRelayUrl(value: string): string;
    fail(message: string, code: string): Error;
    finishAuthorization(pending: StoredPendingAuthorization): Promise<GrantPeerAuthorityResult>;
    authorizationResult(relationship: StoredPeerRelationship): GrantPeerAuthorityResult;
}

/** Grant a peer Device Grant onto this Machine. Display names never authorize. */
export async function grantPeerAuthority(
    fleet: GrantPeerAuthorityFleet,
    command: GrantPeerAuthorityCommand,
): Promise<GrantPeerAuthorityResult> {
    const descriptorHash = createHash('sha256').update(JSON.stringify(command.descriptor)).digest('base64url');
    const completed = fleet.store.authorization(descriptorHash);
    if (completed !== undefined) {
        if (command.relationshipId !== undefined && command.relationshipId !== completed.relationshipId) {
            throw fleet.fail('peer descriptor was reused with a different relationship', 'peer-operation-conflict');
        }
        const pending = fleet.store.pendingAuthorization();
        if (completed.state === 'connected') {
            if (pending?.descriptorHash === descriptorHash) await fleet.store.putPendingAuthorization(undefined);
            return fleet.authorizationResult(completed);
        }
        if (pending === undefined) throw fleet.fail('peer authorization recovery journal is missing', 'peer-operation-uncertain');
        return fleet.finishAuthorization(pending);
    }
    const pending = fleet.store.pendingAuthorization();
    if (pending !== undefined) {
        if (pending.descriptorHash === descriptorHash) return fleet.finishAuthorization(pending);
        await fleet.finishAuthorization(pending);
    }
    const crypto = fleet.readyCrypto();
    const claims = verifySignedPeerDescriptor(command.descriptor, {
        targetMachineId: fleet.machineId,
        targetMachineSigningPublicKey: crypto.signingPublicKey,
        now: fleet.now(),
    });
    if (!isPeerCapabilities(command.capabilities)) throw fleet.fail('invalid peer capabilities', 'peer-invalid-capabilities');
    const allowedCwds = fleet.validateStartDirectories(command.capabilities, command.allowedCwds);
    let targetRelayUrl: string;
    try {
        targetRelayUrl = fleet.canonicalRelayUrl(fleet.relayUrl);
        if (command.targetRelayUrl !== undefined && fleet.canonicalRelayUrl(command.targetRelayUrl) !== targetRelayUrl) {
            throw fleet.fail('target relay assertion does not match this computer', 'peer-bundle-invalid');
        }
    } catch (error) {
        if ((error as { code?: unknown }).code === 'peer-bundle-invalid') throw error;
        throw fleet.fail('invalid target relay endpoint', 'peer-bundle-invalid');
    }
    if (crypto.devices.some((device) => device.devicePublicKey === claims.peerPublicKey)) {
        await fleet.repairOrphanDevices();
    }
    const current = fleet.readyCrypto();
    if (current.devices.some((device) => device.devicePublicKey === claims.peerPublicKey)) {
        throw fleet.fail('peer key is already authorized', 'peer-already-authorized');
    }
    if (DeviceGrant.peerLimitReached(current.devices)) {
        throw fleet.fail('peer limit reached for this personal fleet', 'peer-limit');
    }
    const relationshipId = command.relationshipId ?? `rel_${descriptorHash.slice(0, 32)}`;
    if (fleet.store.relationship(relationshipId) !== undefined) {
        throw fleet.fail('peer relationship id is already in use', 'peer-operation-conflict');
    }
    const authorization: StoredPendingAuthorization = {
        version: 1,
        relationshipId,
        descriptor: command.descriptor,
        descriptorHash,
        sourceMachineId: claims.sourceMachineId,
        ...(claims.sourceName === undefined ? {} : { sourceName: claims.sourceName.trim().slice(0, 120) }),
        ...(claims.sourcePlatform === undefined ? {} : { sourcePlatform: claims.sourcePlatform }),
        peerPublicKey: claims.peerPublicKey,
        capabilities: [...command.capabilities],
        ...(allowedCwds === undefined ? {} : { allowedCwds }),
        relayUrl: targetRelayUrl,
        createdAt: fleet.now(),
    };
    await fleet.store.putPendingAuthorization(authorization);
    return fleet.finishAuthorization(authorization);
}
