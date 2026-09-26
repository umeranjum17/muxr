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
export { createDeviceGrant, verifyDeviceGrant } from './application/deviceGrant.js';
export { PEER_DESCRIPTOR_MAX_TTL_MS, createSignedPeerDescriptor, verifySignedPeerDescriptor } from './application/signPeerDescriptor.js';
export type { PeerInstallBundlePayload } from './application/installPeerBundle.js';
export { openPeerInstallBundle, sealPeerInstallBundle } from './application/installPeerBundle.js';
