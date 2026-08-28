export type { DeviceAuthority, DeviceGrant, SealedDeviceGrant } from './domain/deviceGrant.js';
export { grantAuthority, grantHasExpired, grantIsPeer, parseDeviceAuthority, peerConstraintMessage } from './domain/deviceGrant.js';

export type { KeyPair } from './infrastructure/keys.js';
export { generateKeyPair } from './infrastructure/keys.js';
export {
    PAIRING_CODE_ALPHABET,
    formatPairingCode,
    normalizePairingCode,
    openPairingCodePayload,
    pairingCodeHash,
    parsePairingCode,
    sealPairingCodePayload,
} from './infrastructure/pairing.js';
export { newPreviewKey, openPreviewPayload, sealPreviewPayload } from './infrastructure/preview.js';
export type {
    V2Context,
    V2Direction,
    V2ReplaySnapshot,
    V2ReplayTracker,
    V2SenderState,
} from './infrastructure/envelope.js';
export {
    deriveV2Key,
    hostedRoutingContext,
    isV2Envelope,
    newV2ReplayTracker,
    newV2SenderState,
    openV2,
    sealV2,
    v2EnvelopeSequence,
    v2ReplayFromSnapshot,
    v2SenderFromSnapshot,
    v2SenderToSnapshot,
} from './infrastructure/envelope.js';
export type { SigningKeyPair } from './infrastructure/identity.js';
export { generateSigningKeyPair, signDetached, verifyDetached } from './infrastructure/identity.js';
export { createDeviceGrant, verifyDeviceGrant } from './infrastructure/grants.js';
export { PEER_DESCRIPTOR_MAX_TTL_MS, createSignedPeerDescriptor, verifySignedPeerDescriptor } from './infrastructure/peerDescriptor.js';
export type { PeerInstallBundlePayload } from './infrastructure/peerBundle.js';
export { openPeerInstallBundle, sealPeerInstallBundle } from './infrastructure/peerBundle.js';
