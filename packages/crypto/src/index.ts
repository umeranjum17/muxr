/**
 * End-to-end encryption for relay payloads.
 *
 * Lives in a shared package, NOT in the relay, because the relay must never be
 * able to decrypt anything. Only the machine host and the client hold keys.
 *
 * Pure JS (@byokit/seal) rather than node:crypto so the identical code runs in the
 * daemon and in React Native. X25519 key agreement + XSalsa20-Poly1305 AEAD via
 * the kit's authenticated box, which is authenticated -- a tampered frame fails to open.
 *
 * Peer install bundles and signed grants remain until their link-native
 * authority replaces those product-level proofs.
 */

export type {
    DeviceAuthority,
    DeviceGrant,
    KeyPair,
    PeerInstallBundlePayload,
    SealedDeviceGrant,
    SigningKeyPair,
} from './e2ee/index.js';
export {
    PEER_DESCRIPTOR_MAX_TTL_MS,
    createDeviceGrant,
    createSignedPeerDescriptor,
    generateKeyPair,
    generateSigningKeyPair,
    grantAuthority,
    grantHasExpired,
    grantIsPeer,
    openPeerInstallBundle,
    sealPeerInstallBundle,
    signDetached,
    verifyDetached,
    verifyDeviceGrant,
    verifySignedPeerDescriptor,
} from './e2ee/index.js';
