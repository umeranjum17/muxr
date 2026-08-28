import nacl from 'tweetnacl';
import type { PeerDescriptorClaims, SignedPeerDescriptor } from '@muxr/contract';
import { encodeUtf8, fromBase64, toBase64 } from './encoding.js';
import { signDetached, verifyDetached } from './identity.js';
import { toKeyBytes } from './keys.js';

const PEER_DESCRIPTOR_DOMAIN = 'muxr.peer-descriptor.v1\n';
export const PEER_DESCRIPTOR_MAX_TTL_MS = 5 * 60_000;

function peerDescriptorBytes(claims: PeerDescriptorClaims): Uint8Array {
    return encodeUtf8(PEER_DESCRIPTOR_DOMAIN + JSON.stringify({
        v: 1,
        sourceMachineId: claims.sourceMachineId,
        sourceMachineSigningPublicKey: claims.sourceMachineSigningPublicKey,
        targetMachineId: claims.targetMachineId,
        targetMachineSigningPublicKey: claims.targetMachineSigningPublicKey,
        peerPublicKey: claims.peerPublicKey,
        preparedAt: claims.preparedAt,
        expiresAt: claims.expiresAt,
        nonce: claims.nonce,
        ...(claims.sourceName === undefined ? {} : { sourceName: claims.sourceName }),
        ...(claims.sourcePlatform === undefined ? {} : { sourcePlatform: claims.sourcePlatform }),
    }));
}

function validatePeerDescriptorClaims(claims: PeerDescriptorClaims): void {
    if (claims === null || typeof claims !== 'object' || claims.v !== 1) throw new Error('peer descriptor: unknown version');
    for (const [name, value] of [
        ['sourceMachineId', claims.sourceMachineId],
        ['targetMachineId', claims.targetMachineId],
        ['nonce', claims.nonce],
    ] as const) {
        if (typeof value !== 'string' || value === '') throw new Error(`peer descriptor: ${name} required`);
    }
    if (claims.sourceMachineId === claims.targetMachineId) throw new Error('peer descriptor: source and target must differ');
    if (fromBase64(claims.sourceMachineSigningPublicKey).length !== nacl.sign.publicKeyLength
        || fromBase64(claims.targetMachineSigningPublicKey).length !== nacl.sign.publicKeyLength) {
        throw new Error('peer descriptor: signing keys must be 32-byte ed25519 keys');
    }
    toKeyBytes(claims.peerPublicKey, 'peer descriptor public key');
    if (!Number.isFinite(claims.preparedAt) || !Number.isFinite(claims.expiresAt) || claims.expiresAt <= claims.preparedAt) {
        throw new Error('peer descriptor: invalid validity window');
    }
    if (claims.sourceName !== undefined && typeof claims.sourceName !== 'string') throw new Error('peer descriptor: invalid sourceName');
    if (claims.sourcePlatform !== undefined && typeof claims.sourcePlatform !== 'string') throw new Error('peer descriptor: invalid sourcePlatform');
}

/** Machine-sign the target-bound public half of a prepared peer key. */
export function createSignedPeerDescriptor(params: {
    sourceMachineId: string;
    sourceMachineSigningSecretKey: string;
    targetMachineId: string;
    targetMachineSigningPublicKey: string;
    peerPublicKey: string;
    preparedAt: number;
    expiresAt: number;
    nonce: string;
    sourceName?: string;
    sourcePlatform?: string;
}): SignedPeerDescriptor {
    const secret = fromBase64(params.sourceMachineSigningSecretKey);
    if (secret.length !== nacl.sign.secretKeyLength) throw new Error('peer descriptor: signing secret must be a 64-byte ed25519 key');
    const claims: PeerDescriptorClaims = {
        v: 1,
        sourceMachineId: params.sourceMachineId,
        sourceMachineSigningPublicKey: toBase64(secret.subarray(nacl.sign.publicKeyLength)),
        targetMachineId: params.targetMachineId,
        targetMachineSigningPublicKey: params.targetMachineSigningPublicKey,
        peerPublicKey: params.peerPublicKey,
        preparedAt: params.preparedAt,
        expiresAt: params.expiresAt,
        nonce: params.nonce,
        ...(params.sourceName === undefined ? {} : { sourceName: params.sourceName }),
        ...(params.sourcePlatform === undefined ? {} : { sourcePlatform: params.sourcePlatform }),
    };
    validatePeerDescriptorClaims(claims);
    if (claims.expiresAt - claims.preparedAt > PEER_DESCRIPTOR_MAX_TTL_MS) throw new Error('peer descriptor: validity window too long');
    return { v: 1, claims, signature: signDetached(peerDescriptorBytes(claims), params.sourceMachineSigningSecretKey) };
}

/** Verify the source signature and the target binding before authorizing a peer. */
export function verifySignedPeerDescriptor(
    descriptor: SignedPeerDescriptor,
    opts: { targetMachineId: string; targetMachineSigningPublicKey: string; now?: number },
): PeerDescriptorClaims {
    if (descriptor === null || typeof descriptor !== 'object' || descriptor.v !== 1) throw new Error('peer descriptor: unknown version');
    validatePeerDescriptorClaims(descriptor.claims);
    if (descriptor.claims.targetMachineId !== opts.targetMachineId
        || descriptor.claims.targetMachineSigningPublicKey !== opts.targetMachineSigningPublicKey) {
        throw new Error('peer descriptor: target binding mismatch');
    }
    const now = opts.now ?? Date.now();
    if (descriptor.claims.expiresAt <= now) throw new Error('peer descriptor: expired');
    const windowIsInvalid = descriptor.claims.preparedAt > now + 60_000
        || descriptor.claims.expiresAt - descriptor.claims.preparedAt > PEER_DESCRIPTOR_MAX_TTL_MS;
    if (windowIsInvalid) throw new Error('peer descriptor: invalid validity window');
    const signature = fromBase64(descriptor.signature);
    const signatureIsInvalid = signature.length !== nacl.sign.signatureLength
        || !verifyDetached(peerDescriptorBytes(descriptor.claims), descriptor.signature, descriptor.claims.sourceMachineSigningPublicKey);
    if (signatureIsInvalid) throw new Error('peer descriptor: signature verification failed');
    return descriptor.claims;
}
