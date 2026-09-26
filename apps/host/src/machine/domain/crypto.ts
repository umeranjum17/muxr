import type { LifecycleNotificationLevel, PeerCapability } from '@muxr/contract';

export interface HostedMachineKeys {
    machineId: string;
    keyVersion: number;
    dataKey: string;
    ingressKeys: Readonly<Record<string, string>>;
    deviceKinds?: Readonly<Record<string, 'native' | 'browser' | 'peer'>>;
    deviceAuthorities?: Readonly<Record<string, 'control' | 'observe'>>;
    deviceDataKeys?: Readonly<Record<string, string>>;
    deviceCapabilities?: Readonly<Record<string, readonly PeerCapability[]>>;
    deviceAllowedCwds?: Readonly<Record<string, readonly string[]>>;
    deviceExpiresAt?: Readonly<Record<string, number>>;
}

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
    /** Display name the device chose at pairing; relay-paired devices keep their
     *  name on the relay, link-paired ones only here. Names never authorize. */
    name?: string;
    /**
     * Explicit personal-browser opt-in (`muxr pair --browser-personal`).
     * Only this marker lifts the host refresh clamp from 8h to 30d.
     */
    personal?: boolean;
    /** Push policy persists with the trusted device, not the relay registration. */
    pushLevel?: LifecycleNotificationLevel;
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
