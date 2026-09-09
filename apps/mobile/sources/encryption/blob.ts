/**
 * Binary blob encryption/decryption using NaCl crypto_secretbox (XSalsa20-Poly1305).
 *
 * Unlike encryptSecretBox in libsodium.ts, this operates on raw Uint8Array
 * without JSON serialization, making it suitable for image/file blobs.
 *
 * Wire format: [nonce (24 bytes)] [ciphertext + auth tag (16 bytes + data)]
 */
import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from 'expo-crypto';

function standaloneBytes(view: Uint8Array): Uint8Array {
    if (view.byteOffset === 0 && view.buffer.byteLength === view.length) return view;
    return view.slice();
}

/**
 * Encrypt a binary blob with a 32-byte secret key.
 * Returns: nonce (24) + ciphertext (data.length + 16 auth tag)
 */
export function encryptBlob(data: Uint8Array, key: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
    // Defensive copies: the native libsodium TurboModule on iOS reads
    // arguments via getArrayBuffer().length(runtime), which returns the
    // *underlying ArrayBuffer's* byteLength rather than the view length.
    // If a caller passes in a Uint8Array view onto a larger buffer, the
    // native side can either reject it ("invalid key length") or read
    // the wrong bytes. Materializing standalone copies for data/key
    // makes those checks see exactly the bytes we intended to pass in.
    const encrypted = sodium.crypto_secretbox_easy(standaloneBytes(data), nonce, standaloneBytes(key));
    const encryptedStandalone = standaloneBytes(encrypted);
    const result = new Uint8Array(nonce.length + encryptedStandalone.length);
    result.set(nonce, 0);
    result.set(encryptedStandalone, nonce.length);
    return result;
}

/**
 * Decrypt a blob previously encrypted with encryptBlob.
 * Returns null if decryption fails (wrong key, corrupted, truncated).
 */
export function decryptBlob(bundle: Uint8Array, key: Uint8Array): Uint8Array | null {
    if (bundle.length < sodium.crypto_secretbox_NONCEBYTES + 16) {
        return null;
    }
    const nonce = bundle.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = bundle.slice(sodium.crypto_secretbox_NONCEBYTES);
    try {
        return sodium.crypto_secretbox_open_easy(ciphertext, nonce, standaloneBytes(key));
    } catch {
        return null;
    }
}
