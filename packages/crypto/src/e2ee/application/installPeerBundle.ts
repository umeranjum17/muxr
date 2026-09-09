import nacl from 'tweetnacl';
import { isPeerCapabilities, type PeerAuthorityMetadata, type PeerCapability } from '@muxr/contract/peer';
import { isWebSocketRelayUrl } from '@muxr/contract/control-plane';
import { concatBytes, decodeUtf8, encodeUtf8, fromBase64, toBase64 } from '../infrastructure/encoding.js';
import type { SealedDeviceGrant } from '../domain/deviceGrant.js';
import { signDetached, verifyDetached } from '../infrastructure/identity.js';
import { toKeyBytes, type KeyPair } from '../infrastructure/keys.js';

export interface PeerInstallBundlePayload {
    v: 1;
    relationshipId: string;
    targetMachineId: string;
    targetMachineName?: string;
    targetPlatform?: string;
    targetMachineSigningPublicKey: string;
    relayUrl: string;
    peerDeviceId: string;
    credential: string;
    /** Hosted generic pairing grant refresh path, bound inside the signed bundle. */
    grantPath?: string;
    grant: SealedDeviceGrant;
    capabilities: PeerCapability[];
    issuedAt: number;
    authority?: PeerAuthorityMetadata;
}

interface SealedPeerInstallBundle {
    v: 1;
    sender: string;
    box: string;
    signer: string;
    sig: string;
}

function validatePeerInstallBundle(payload: PeerInstallBundlePayload): void {
    if (payload === null || typeof payload !== 'object' || payload.v !== 1) throw new Error('peer bundle: unknown version');
    for (const [name, value] of [
        ['relationshipId', payload.relationshipId],
        ['targetMachineId', payload.targetMachineId],
        ['relayUrl', payload.relayUrl],
        ['peerDeviceId', payload.peerDeviceId],
        ['credential', payload.credential],
    ] as const) {
        if (typeof value !== 'string' || value === '') throw new Error(`peer bundle: ${name} required`);
    }
    if (!isWebSocketRelayUrl(payload.relayUrl)) throw new Error('peer bundle: relayUrl must use ws or wss');
    if (payload.grantPath !== undefined && !/^\/v1\/pair-sessions\/[^/]+\/grant$/.test(payload.grantPath)) {
        throw new Error('peer bundle: invalid grant refresh path');
    }
    if (fromBase64(payload.targetMachineSigningPublicKey).length !== nacl.sign.publicKeyLength) {
        throw new Error('peer bundle: invalid target signing key');
    }
    if (!isPeerCapabilities(payload.capabilities)) throw new Error('peer bundle: invalid capabilities');
    if (!Number.isFinite(payload.issuedAt)) throw new Error('peer bundle: invalid issue time');
    if (payload.grant === null || typeof payload.grant !== 'object' || payload.grant.v !== 1) throw new Error('peer bundle: malformed grant');
}

/** Target-sign and box the credential + signed grant so the phone only forwards opaque bytes. */
export function sealPeerInstallBundle(params: {
    payload: PeerInstallBundlePayload;
    targetMachineSigningSecretKey: string;
    targetMachineKey: KeyPair;
    peerPublicKey: string;
}): string {
    validatePeerInstallBundle(params.payload);
    const signingSecret = fromBase64(params.targetMachineSigningSecretKey);
    if (signingSecret.length !== nacl.sign.secretKeyLength) throw new Error('peer bundle: invalid signing secret');
    toKeyBytes(params.targetMachineKey.secretKey, 'peer bundle target secret key');
    toKeyBytes(params.peerPublicKey, 'peer bundle recipient key');
    const plaintext = encodeUtf8(JSON.stringify(params.payload));
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(
        plaintext,
        nonce,
        fromBase64(params.peerPublicKey),
        fromBase64(params.targetMachineKey.secretKey),
    );
    const sealed: SealedPeerInstallBundle = {
        v: 1,
        sender: params.targetMachineKey.publicKey,
        box: toBase64(concatBytes(nonce, ciphertext)),
        signer: toBase64(signingSecret.subarray(nacl.sign.publicKeyLength)),
        sig: signDetached(plaintext, params.targetMachineSigningSecretKey),
    };
    return JSON.stringify(sealed);
}

/** Open an opaque install bundle and verify the target signature before exposing its credential. */
export function openPeerInstallBundle(
    value: string,
    opts: { peerKey: KeyPair; pinnedTargetMachineSigningPublicKey: string },
): PeerInstallBundlePayload {
    let sealed: SealedPeerInstallBundle;
    try { sealed = JSON.parse(value) as SealedPeerInstallBundle; }
    catch { throw new Error('peer bundle: malformed seal'); }
    if (sealed === null || typeof sealed !== 'object' || sealed.v !== 1) throw new Error('peer bundle: unknown version');
    if (sealed.signer !== opts.pinnedTargetMachineSigningPublicKey) throw new Error('peer bundle: signer is not the pinned target key');
    toKeyBytes(opts.peerKey.secretKey, 'peer bundle recipient secret key');
    const box = fromBase64(sealed.box);
    if (box.length <= nacl.box.nonceLength) throw new Error('peer bundle: malformed box');
    const opened = nacl.box.open(
        box.subarray(nacl.box.nonceLength),
        box.subarray(0, nacl.box.nonceLength),
        fromBase64(sealed.sender),
        fromBase64(opts.peerKey.secretKey),
    );
    if (opened === null) throw new Error('peer bundle: decryption failed');
    if (!verifyDetached(opened, sealed.sig, opts.pinnedTargetMachineSigningPublicKey)) {
        throw new Error('peer bundle: signature verification failed');
    }
    let payload: PeerInstallBundlePayload;
    try { payload = JSON.parse(decodeUtf8(opened)) as PeerInstallBundlePayload; }
    catch { throw new Error('peer bundle: malformed payload'); }
    validatePeerInstallBundle(payload);
    if (payload.targetMachineSigningPublicKey !== opts.pinnedTargetMachineSigningPublicKey) {
        throw new Error('peer bundle: target signing key mismatch');
    }
    return payload;
}
