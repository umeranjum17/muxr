import type { PeerCapability } from '@muxr/contract';

export interface MachineDeviceRecord {
    deviceId: string;
    devicePublicKey: string;
    ingressKey: string;
    /** Peer-only host->peer root; peers never receive the machine broadcast root. */
    dataKey?: string;
    expiresAt: string;
    /** Omitted kind means native; auth files never persist `kind: 'native'`. */
    kind?: 'browser' | 'peer';
    authority?: 'control' | 'observe';
    capabilities?: PeerCapability[];
    allowedCwds?: string[];
}

export interface MachineRotationGrant {
    deviceId?: string;
    devicePublicKey?: string;
    device_public_key?: string;
    grant: string;
}

export interface MachinePendingRotation {
    kind?: 'selfhost-revoke-v1' | 'peer-revoke-v1';
    authorityKind?: 'selfhost' | 'hosted';
    revokedDeviceId?: string;
    revokedDeviceName?: string;
    previousKeyVersion?: number;
    keyVersion: number;
    dataKey: string;
    devices: MachineDeviceRecord[];
    grants: MachineRotationGrant[];
}

export interface MachineCryptoState {
    signingPublicKey: string;
    signingSecretKey: string;
    boxPublicKey: string;
    boxSecretKey: string;
    dataKey: string;
    keyVersion: number;
    devices: MachineDeviceRecord[];
    pendingRotation?: MachinePendingRotation;
}

export interface MachineCryptoAdapter {
    get(): MachineCryptoState;
    commit(next: MachineCryptoState): Promise<void>;
}
