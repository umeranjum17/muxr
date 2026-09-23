import * as Crypto from 'expo-crypto';

export async function artifactChunkHash(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
