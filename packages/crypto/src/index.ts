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

export type { KeyPair } from './keys.js';
export { generateKeyPair } from './keys.js';
export {
    PAIRING_CODE_ALPHABET,
    formatPairingCode,
    normalizePairingCode,
    openPairingCodePayload,
    pairingCodeHash,
    sealPairingCodePayload,
} from './pairing.js';
export { newPreviewKey, openPreviewPayload, sealPreviewPayload } from './preview.js';
export type {
    V2Context,
    V2Direction,
    V2ReplaySnapshot,
    V2ReplayTracker,
    V2SenderState,
} from './envelope.js';
export {
    deriveV2Key,
    isV2Envelope,
    newV2ReplayTracker,
    newV2SenderState,
    openV2,
    sealV2,
    v2EnvelopeSequence,
    v2ReplayFromSnapshot,
    v2SenderFromSnapshot,
    v2SenderToSnapshot,
} from './envelope.js';
export type { SigningKeyPair } from './identity.js';
export { generateSigningKeyPair, signDetached, verifyDetached } from './identity.js';
export type { DeviceAuthority, DeviceGrant, SealedDeviceGrant } from './grants.js';
export { createDeviceGrant, verifyDeviceGrant } from './grants.js';
export { PEER_DESCRIPTOR_MAX_TTL_MS, createSignedPeerDescriptor, verifySignedPeerDescriptor } from './peerDescriptor.js';
export type { PeerInstallBundlePayload } from './peerBundle.js';
export { openPeerInstallBundle, sealPeerInstallBundle } from './peerBundle.js';
