/**
 * End-to-end encryption for relay payloads.
 *
 * Lives in a shared package, NOT in the relay, because the relay must never be
 * able to decrypt anything. Only the machine host and the client hold keys.
 *
 * Pure JS (tweetnacl) rather than node:crypto so the identical code runs in the
 * daemon and in React Native. X25519 key agreement + XSalsa20-Poly1305 AEAD via
 * nacl.box, which is authenticated -- a tampered frame fails to open.
 *
 * Production traffic uses the strict v2 envelope and the ed25519/X25519
 * grant helpers. Local development is deliberately cleartext rather
 * than carrying a second, downgrade-prone encryption protocol.
 */

export type {
    DeviceAuthority,
    DeviceGrant,
    KeyPair,
    PeerInstallBundlePayload,
    SealedDeviceGrant,
    SigningKeyPair,
    V2Context,
    V2Direction,
    V2ReplaySnapshot,
    V2ReplayTracker,
    V2SenderState,
} from './e2ee/index.js';
export {
    PAIRING_CODE_ALPHABET,
    PEER_DESCRIPTOR_MAX_TTL_MS,
    createDeviceGrant,
    createSignedPeerDescriptor,
    deriveV2Key,
    formatPairingCode,
    generateKeyPair,
    generateSigningKeyPair,
    grantAuthority,
    grantIsPeer,
    hostedRoutingContext,
    isV2Envelope,
    newPreviewKey,
    newV2ReplayTracker,
    newV2SenderState,
    normalizePairingCode,
    openPairingCodePayload,
    openPeerInstallBundle,
    openPreviewPayload,
    openV2,
    pairingCodeHash,
    parsePairingCode,
    sealPairingCodePayload,
    sealPeerInstallBundle,
    sealPreviewPayload,
    sealV2,
    signDetached,
    v2EnvelopeSequence,
    v2ReplayFromSnapshot,
    v2SenderFromSnapshot,
    v2SenderToSnapshot,
    verifyDetached,
    verifyDeviceGrant,
    verifySignedPeerDescriptor,
} from './e2ee/index.js';
