import nacl from 'tweetnacl';
import { fromBase64, toBase64 } from './encoding.js';

export interface KeyPair {
    /** base64 */
    publicKey: string;
    /** base64 -- never leaves the device that generated it */
    secretKey: string;
}

export function generateKeyPair(): KeyPair {
    const pair = nacl.box.keyPair();
    return { publicKey: toBase64(pair.publicKey), secretKey: toBase64(pair.secretKey) };
}

export function toKeyBytes(key: string | Uint8Array, what: string): Uint8Array {
    const bytes = typeof key === 'string' ? fromBase64(key) : key;
    if (bytes.length !== nacl.secretbox.keyLength) {
        throw new Error(`${what}: key must be ${nacl.secretbox.keyLength} bytes`);
    }
    return bytes;
}
