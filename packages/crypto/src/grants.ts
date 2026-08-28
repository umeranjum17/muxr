import nacl from 'tweetnacl';
import { isPeerCapabilities, type DeviceKind, type PeerCapability } from '@muxr/contract';
import { concatBytes, decodeUtf8, encodeUtf8, fromBase64, toBase64 } from './encoding.js';
import { signDetached, verifyDetached } from './identity.js';
import { toKeyBytes, type KeyPair } from './keys.js';

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

function assertCreatedPeerConstraints(
    deviceKind: DeviceKind | undefined,
    authority: DeviceAuthority | undefined,
    capabilities: PeerCapability[] | undefined,
    allowedCwds: string[] | undefined,
): void {
    const isPeerDevice = deviceKind === 'peer';
    if (!isPeerDevice) {
        if (capabilities !== undefined || allowedCwds !== undefined) {
            throw new Error('grant: peer constraints are valid only for peer devices');
        }
        return;
    }
    if (!isPeerCapabilities(capabilities)) throw new Error('grant: peer capabilities required');
    if (authority !== undefined) throw new Error('grant: peer devices cannot carry broad authority');
    const canStart = capabilities.includes('start');
    if (canStart) {
        const directoriesAreMissing = allowedCwds === undefined || allowedCwds.length === 0
            || allowedCwds.some((cwd) => typeof cwd !== 'string' || cwd.trim() === '');
        if (directoriesAreMissing) throw new Error('grant: peer start requires allowed directories');
        return;
    }
    if (allowedCwds !== undefined) throw new Error('grant: allowed directories require peer start');
}

function assertOpenedPeerConstraints(parsed: DeviceGrant): void {
    const isPeerDevice = parsed.deviceKind === 'peer';
    if (!isPeerDevice) {
        if (parsed.capabilities !== undefined || parsed.allowedCwds !== undefined) {
            throw new Error('grant: peer constraints are valid only for peer devices');
        }
        return;
    }
    if (parsed.authority !== undefined) throw new Error('grant: peer devices cannot carry broad authority');
    if (!isPeerCapabilities(parsed.capabilities)) throw new Error('grant: invalid peer capabilities');
    const canStart = parsed.capabilities.includes('start');
    if (canStart) {
        const directoriesAreInvalid = !Array.isArray(parsed.allowedCwds) || parsed.allowedCwds.length === 0
            || parsed.allowedCwds.some((cwd) => typeof cwd !== 'string' || cwd.trim() === '');
        if (directoriesAreInvalid) throw new Error('grant: invalid peer start directories');
        return;
    }
    if (parsed.allowedCwds !== undefined) throw new Error('grant: allowed directories require peer start');
}

/**
 * Create a device grant: signed by the machine's ed25519 key, encrypted to the
 * device's X25519 public key. Carries the machine data key and per-device
 * ingress key plus its lifetime, key generation, and device binding.
 */
export function createDeviceGrant(params: {
    machineId: string;
    /** Machine ed25519 signing secret key, base64. */
    machineSigningSecretKey: string;
    /** Machine X25519 keypair; its public key travels in the grant as `sender`. */
    machineKey: KeyPair;
    deviceId: string;
    /** Device X25519 public key, base64 -- the grant is encrypted to this. */
    devicePublicKey: string;
    /** 32-byte root for host->device data, base64 or bytes. */
    dataKey: string | Uint8Array;
    /** 32-byte root for device->host ingress, base64 or bytes. */
    ingressKey: string | Uint8Array;
    keyVersion: number;
    /** Durable native grants use a parser-safe far-future timestamp. */
    expiresAt: number;
    authority?: DeviceAuthority;
    deviceKind?: DeviceKind;
    capabilities?: readonly PeerCapability[];
    allowedCwds?: readonly string[];
}): SealedDeviceGrant {
    const { machineId, deviceId, devicePublicKey, keyVersion, expiresAt } = params;
    if (typeof machineId !== 'string' || machineId === '') throw new Error('grant: machineId required');
    if (typeof deviceId !== 'string' || deviceId === '') throw new Error('grant: deviceId required');
    if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new Error('grant: key generation must be a positive integer');
    if (!Number.isFinite(expiresAt)) throw new Error('grant: expiresAt required');
    toKeyBytes(devicePublicKey, 'grant devicePublicKey');
    toKeyBytes(params.machineKey.secretKey, 'grant machineKey.secretKey');
    const signingSecret = fromBase64(params.machineSigningSecretKey);
    if (signingSecret.length !== nacl.sign.secretKeyLength) {
        throw new Error('grant: machineSigningSecretKey must be a 64-byte ed25519 secret key');
    }
    const capabilities = params.capabilities === undefined ? undefined : [...params.capabilities];
    const allowedCwds = params.allowedCwds === undefined ? undefined : [...params.allowedCwds];
    assertCreatedPeerConstraints(params.deviceKind, params.authority, capabilities, allowedCwds);
    // tweetnacl ed25519 secret keys append the public key in the last 32 bytes.
    const machineSigningPublicKey = toBase64(signingSecret.subarray(nacl.sign.publicKeyLength));
    const isPeerDevice = params.deviceKind === 'peer';
    const grant: DeviceGrant = {
        machineId,
        machineSigningPublicKey,
        deviceId,
        devicePublicKey,
        keyVersion,
        expiresAt,
        ...(params.deviceKind === undefined ? {} : { deviceKind: params.deviceKind }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(allowedCwds === undefined ? {} : { allowedCwds }),
        ...(isPeerDevice ? {} : { authority: params.authority ?? 'control' }),
        dataKey: toBase64(toKeyBytes(params.dataKey, 'grant dataKey')),
        ingressKey: toBase64(toKeyBytes(params.ingressKey, 'grant ingressKey')),
    };
    const plaintext = encodeUtf8(JSON.stringify(grant));
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box(plaintext, nonce, fromBase64(devicePublicKey), fromBase64(params.machineKey.secretKey));
    return {
        v: 1,
        sender: params.machineKey.publicKey,
        box: toBase64(concatBytes(nonce, box)),
        signer: machineSigningPublicKey,
        sig: signDetached(plaintext, params.machineSigningSecretKey),
    };
}

/**
 * Verify a device grant with the pinned machine signing public key and the
 * device's own X25519 keypair. Fails closed on any mismatch: unknown version,
 * wrong pinned key, undecryptable box, bad signature, expired, or a device
 * binding that does not match the verifying key. Durable native devices use
 * explicit credential revocation and key rotation; short-lived browser grants
 * are additionally fenced by `expiresAt`.
 */
export function verifyDeviceGrant(
    grant: SealedDeviceGrant,
    opts: {
        /** The machine ed25519 public key the client pins out-of-band. */
        pinnedMachineSigningPublicKey: string;
        /** The device's X25519 keypair; the secret key decrypts the box. */
        deviceKey: KeyPair;
        /** Optional extra binding check against the grant's deviceId. */
        deviceId?: string;
    },
): DeviceGrant {
    if (grant === null || typeof grant !== 'object') throw new Error('grant: malformed grant');
    if (grant.v !== 1) throw new Error(`grant: unknown version ${grant.v}`);
    if (grant.signer !== opts.pinnedMachineSigningPublicKey) throw new Error('grant: signer is not the pinned machine key');
    toKeyBytes(opts.deviceKey.secretKey, 'grant deviceKey.secretKey');
    const boxBytes = fromBase64(grant.box);
    if (boxBytes.length < nacl.box.nonceLength) throw new Error('grant: malformed box');
    const nonce = boxBytes.subarray(0, nacl.box.nonceLength);
    const ciphertext = boxBytes.subarray(nacl.box.nonceLength);
    const opened = nacl.box.open(ciphertext, nonce, fromBase64(grant.sender), fromBase64(opts.deviceKey.secretKey));
    if (opened === null) throw new Error('grant: decryption failed (not addressed to this device key)');
    if (!verifyDetached(opened, grant.sig, opts.pinnedMachineSigningPublicKey)) {
        throw new Error('grant: signature verification failed');
    }
    let parsed: DeviceGrant;
    try {
        parsed = JSON.parse(decodeUtf8(opened)) as DeviceGrant;
    } catch {
        throw new Error('grant: malformed plaintext');
    }
    if (typeof parsed.machineId !== 'string' || parsed.machineId === '') throw new Error('grant: malformed machineId');
    if (parsed.machineSigningPublicKey !== opts.pinnedMachineSigningPublicKey) throw new Error('grant: signer mismatch');
    if (parsed.devicePublicKey !== opts.deviceKey.publicKey) throw new Error('grant: device binding mismatch');
    if (opts.deviceId !== undefined && parsed.deviceId !== opts.deviceId) throw new Error('grant: device id mismatch');
    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) throw new Error('grant: invalid expiry');
    if (parsed.expiresAt <= Date.now()) throw new Error('grant: expired');
    const authorityIsUnknown = parsed.authority !== undefined && parsed.authority !== 'control' && parsed.authority !== 'observe';
    if (authorityIsUnknown) throw new Error('grant: invalid authority');
    const kindIsUnknown = parsed.deviceKind !== undefined
        && parsed.deviceKind !== 'native'
        && parsed.deviceKind !== 'browser'
        && parsed.deviceKind !== 'peer';
    if (kindIsUnknown) throw new Error('grant: invalid device kind');
    assertOpenedPeerConstraints(parsed);
    if (!Number.isInteger(parsed.keyVersion) || parsed.keyVersion < 1) throw new Error('grant: invalid key generation');
    if (typeof parsed.dataKey !== 'string' || toKeyBytes(parsed.dataKey, 'grant dataKey').length !== 32) throw new Error('grant: invalid dataKey');
    if (typeof parsed.ingressKey !== 'string' || toKeyBytes(parsed.ingressKey, 'grant ingressKey').length !== 32) throw new Error('grant: invalid ingressKey');
    return parsed;
}
