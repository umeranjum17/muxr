import type { DeviceKind, PeerCapability, PeerGrantConstraintError } from '@muxr/contract';

export type DeviceAuthority = 'control' | 'observe';

export interface DeviceGrant {
    machineId: string;
    /** Machine ed25519 signing public key, base64; cross-checked against the pinned key. */
    machineSigningPublicKey: string;
    deviceId: string;
    /** Device X25519 public key the grant was encrypted to, base64. */
    devicePublicKey: string;
    keyVersion: number;
    /** Durable grants remain valid until explicit revocation. */
    expiresAt: number;
    /** Host-enforced device role. Legacy grants omit it and are interpreted by device kind. */
    authority?: DeviceAuthority;
    /** Distinguishes constrained peers from native and browser clients. Legacy grants omit it. */
    deviceKind?: DeviceKind;
    /** Signed, host-enforced peer allowlist. Present only when deviceKind is peer. */
    capabilities?: PeerCapability[];
    /** Signed start roots. Required only when a peer has the advanced start capability. */
    allowedCwds?: string[];
    /** 32-byte root for host->device data, base64. */
    dataKey: string;
    /** 32-byte root for device->host ingress, base64. */
    ingressKey: string;
}

export interface SealedDeviceGrant {
    // Wire-stable grant schema. This is unrelated to the retired shared-key transport.
    v: 1;
    /** Machine X25519 public key that sealed the box, base64. */
    sender: string;
    /** base64(nonce || ciphertext), encrypted to the device X25519 public key. */
    box: string;
    /** Machine ed25519 signing public key, base64; must equal the pinned key. */
    signer: string;
    /** base64 detached ed25519 signature over the exact grant plaintext bytes. */
    sig: string;
}

export function grantIsPeer(grant: { deviceKind?: DeviceKind }): boolean {
    return grant.deviceKind === 'peer';
}

/** Broad host authority. Peers never carry it; native/browser default to control. */
export function grantAuthority(grant: { deviceKind?: DeviceKind; authority?: DeviceAuthority }): DeviceAuthority | undefined {
    if (grantIsPeer(grant)) return undefined;
    return grant.authority ?? 'control';
}

const CREATE_PEER_CONSTRAINT_ERRORS: Record<PeerGrantConstraintError, string> = {
    'constraints-on-non-peer': 'grant: peer constraints are valid only for peer devices',
    'missing-capabilities': 'grant: peer capabilities required',
    'broad-authority': 'grant: peer devices cannot carry broad authority',
    'missing-start-directories': 'grant: peer start requires allowed directories',
    'directories-without-start': 'grant: allowed directories require peer start',
};

const VERIFY_PEER_CONSTRAINT_ERRORS: Record<PeerGrantConstraintError, string> = {
    ...CREATE_PEER_CONSTRAINT_ERRORS,
    'missing-capabilities': 'grant: invalid peer capabilities',
    'missing-start-directories': 'grant: invalid peer start directories',
};

export function peerConstraintMessage(error: PeerGrantConstraintError, phase: 'create' | 'verify'): string {
    if (phase === 'create') return CREATE_PEER_CONSTRAINT_ERRORS[error];
    return VERIFY_PEER_CONSTRAINT_ERRORS[error];
}
