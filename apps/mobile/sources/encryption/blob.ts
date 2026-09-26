import { getRandomBytes } from 'expo-crypto';
import { openSecretBox, sealSecretBox } from '@byokit/seal';

/** Stored blob format remains nonce (24) | XSalsa20-Poly1305 ciphertext. */
export function encryptBlob(data: Uint8Array, key: Uint8Array): Uint8Array {
    return sealSecretBox(data, key, getRandomBytes);
}

export function decryptBlob(bundle: Uint8Array, key: Uint8Array): Uint8Array | null {
    return openSecretBox(bundle, key);
}
