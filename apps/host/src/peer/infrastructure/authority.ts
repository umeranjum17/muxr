import { createHash } from 'node:crypto';
import type { PeerAuthorityMetadata, PeerCapability } from '@muxr/contract';
import type { MachineRotationGrant } from '../../machine/index.js';

export interface PeerAuthority {
    readonly kind: 'selfhost' | 'hosted';
    issuePeer(input: {
        peerPublicKey: string;
        sourceMachineId: string;
        sourceName: string;
        capabilities: PeerCapability[];
        credentialExpiresAt: number;
        refreshAfter: number;
    }): Promise<{ peerDeviceId: string; authority: PeerAuthorityMetadata }>;
    uploadGrant(peerDeviceId: string, grant: string, keyVersion: number): Promise<void>;
    revokePeer(peerDeviceId: string): Promise<void>;
    publishRotation(keyVersion: number, grants: MachineRotationGrant[]): Promise<void>;
}

/** The host's durable crypto device table is the sole peer authority. */
export class LinkPeerAuthority implements PeerAuthority {
    constructor(readonly kind: 'selfhost' | 'hosted', private readonly machineId: string) {}

    async issuePeer(input: Parameters<PeerAuthority['issuePeer']>[0]) {
        // Stable across a crash between issuance and the pending journal write.
        const peerDeviceId = `dev_${createHash('sha256').update('muxr-peer-link-v1\0').update(this.machineId)
            .update('\0').update(input.peerPublicKey).digest('base64url').slice(0, 32)}`;
        return {
            peerDeviceId,
            authority: {
                authorityId: `link:${this.machineId}`,
                credentialExpiresAt: input.credentialExpiresAt,
                refreshAfter: input.refreshAfter,
            },
        };
    }

    // The signed grant travels in the sealed install bundle. Crypto commit
    // updates the host state; LinkEndpoint.sync enrols/revokes from that state.
    async uploadGrant(): Promise<void> {}
    async revokePeer(): Promise<void> {}
    async publishRotation(): Promise<void> {}
}
