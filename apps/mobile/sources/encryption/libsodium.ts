import { getRandomBytes } from 'expo-crypto';
import { boxKeyPairFromSeed, openBox, openJson, sealBox, sealJson } from '@byokit/seal';

export function getPublicKeyForBox(seed: Uint8Array): Uint8Array {
    return boxKeyPairFromSeed(seed).publicKey;
}

export function encryptBox(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    return sealBox(data, recipientPublicKey, getRandomBytes);
}

/** The stored key is the original 32-byte seed, not the derived X25519 secret. */
export function decryptBox(bundle: Uint8Array, recipientSeed: Uint8Array): Uint8Array | null {
    return openBox(bundle, recipientSeed);
}

export function encryptSecretBox(data: unknown, secret: Uint8Array): Uint8Array {
    return sealJson(data, secret, getRandomBytes);
}

export function decryptSecretBox(data: Uint8Array, secret: Uint8Array): unknown | null {
    return openJson(data, secret);
}
