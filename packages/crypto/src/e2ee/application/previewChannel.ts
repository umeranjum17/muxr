import nacl from 'tweetnacl';
import { concatBytes, toBase64 } from '../infrastructure/encoding.js';
import { toKeyBytes } from '../infrastructure/keys.js';

/** Per-preview root delivered inside the existing encrypted control channel. */
export function newPreviewKey(): string {
    return toBase64(nacl.randomBytes(nacl.secretbox.keyLength));
}

/** Encrypt one TCP payload; connection ids and close flags remain relay-routable. */
export function sealPreviewPayload(payload: Uint8Array, key: string): Uint8Array {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(payload, nonce, toKeyBytes(key, 'preview key'));
    return concatBytes(nonce, ciphertext);
}

export function openPreviewPayload(payload: Uint8Array, key: string): Uint8Array {
    if (payload.length <= nacl.secretbox.nonceLength) throw new Error('preview payload is malformed');
    const opened = nacl.secretbox.open(
        payload.subarray(nacl.secretbox.nonceLength),
        payload.subarray(0, nacl.secretbox.nonceLength),
        toKeyBytes(key, 'preview key'),
    );
    if (opened === null) throw new Error('preview payload failed authentication');
    return opened;
}
