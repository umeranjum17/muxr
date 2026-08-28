export type { DeviceAuthority, DeviceGrant, SealedDeviceGrant } from './domain/deviceGrant.js';
export { grantAuthority, grantHasExpired, grantIsPeer, parseDeviceAuthority, peerConstraintMessage } from './domain/deviceGrant.js';

export type { KeyPair } from './infrastructure/keys.js';
export { generateKeyPair } from './infrastructure/keys.js';
export type { SigningKeyPair } from './infrastructure/identity.js';
export { generateSigningKeyPair, signDetached, verifyDetached } from './infrastructure/identity.js';

export {
    PAIRING_CODE_ALPHABET,
    formatPairingCode,
    normalizePairingCode,
    openPairingCodePayload,
    pairingCodeHash,
    parsePairingCode,
    sealPairingCodePayload,
} from './application/pairMachine.js';
export { newPreviewKey, openPreviewPayload, sealPreviewPayload } from './application/previewChannel.js';
export type {
    V2Context,
    V2Direction,
    V2ReplaySnapshot,
    V2ReplayTracker,
    V2SenderState,
} from './application/envelope.js';
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
} from './application/envelope.js';
export { createDeviceGrant, verifyDeviceGrant } from './application/deviceGrant.js';
export { PEER_DESCRIPTOR_MAX_TTL_MS, createSignedPeerDescriptor, verifySignedPeerDescriptor } from './application/signPeerDescriptor.js';
export type { PeerInstallBundlePayload } from './application/installPeerBundle.js';
export { openPeerInstallBundle, sealPeerInstallBundle } from './application/installPeerBundle.js';
