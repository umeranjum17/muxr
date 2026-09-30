import { signingKeyPairFromSeed, signDetached as sign, verifyDetached as verify } from '@byokit/seal';
import { fromBase64, toBase64 } from './encoding.js';

export interface SigningKeyPair {
    /** base64 ed25519 public key (32 bytes). */
    publicKey: string;
    /** base64 ed25519 secret key (64 bytes) -- never leaves the machine. */
    secretKey: string;
}

/** Machine ed25519 identity. */
export function generateSigningKeyPair(): SigningKeyPair {
    const pair = signingKeyPairFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    return { publicKey: toBase64(pair.publicKey), secretKey: toBase64(pair.secretKey) };
}

/** Detached ed25519 signature (base64). */
export function signDetached(bytes: Uint8Array, secretKeyBase64: string): string {
    return toBase64(sign(bytes, fromBase64(secretKeyBase64)));
}

export function verifyDetached(bytes: Uint8Array, signatureBase64: string, publicKeyBase64: string): boolean {
    return verify(bytes, fromBase64(signatureBase64), fromBase64(publicKeyBase64));
}
