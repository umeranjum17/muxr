import nacl from 'tweetnacl';
import { fail, ok, unwrapOrThrow, type Outcome } from '@muxr/contract';
import { concatBytes, decodeUtf8, encodeUtf8, fromBase64, toBase64 } from './encoding.js';

const PAIRING_CODE_PREFIX = 'muxr:pair-code:v1:';
const PAIRING_CODE_DOMAIN = encodeUtf8('muxr.pair-code.v1');
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function parsePairingCode(value: unknown): Outcome<string> {
    if (typeof value !== 'string') return fail('pairing code must contain ten unambiguous letters or numbers');
    const normalized = value.toUpperCase().replace(/[\s-]/g, '');
    const hasDisallowedCharacter = [...normalized].some((character) => !PAIRING_CODE_ALPHABET.includes(character));
    if (normalized.length !== 10 || hasDisallowedCharacter) {
        return fail('pairing code must contain ten unambiguous letters or numbers');
    }
    return ok(normalized);
}

export function normalizePairingCode(value: string): string {
    return unwrapOrThrow(parsePairingCode(value));
}

export function formatPairingCode(value: string): string {
    const normalized = normalizePairingCode(value);
    return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

function pairingCodeKey(value: string): Uint8Array {
    return nacl.hash(concatBytes(PAIRING_CODE_DOMAIN, encodeUtf8(normalizePairingCode(value))))
        .subarray(0, nacl.secretbox.keyLength);
}

/** Hash sent to the relay for lookup; the human code itself never leaves the devices. */
export function pairingCodeHash(value: string): string {
    return toBase64(nacl.hash(concatBytes(PAIRING_CODE_DOMAIN, pairingCodeKey(value))).subarray(0, 32))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encrypt the full high-entropy pairing payload before the relay stores it. */
export function sealPairingCodePayload(payload: string, code: string): string {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(encodeUtf8(payload), nonce, pairingCodeKey(code));
    return PAIRING_CODE_PREFIX + toBase64(concatBytes(nonce, ciphertext));
}

export function openPairingCodePayload(payload: string, code: string): string {
    if (!payload.startsWith(PAIRING_CODE_PREFIX)) throw new Error('unknown pairing code payload');
    const bytes = fromBase64(payload.slice(PAIRING_CODE_PREFIX.length));
    if (bytes.length <= nacl.secretbox.nonceLength) throw new Error('malformed pairing code payload');
    const opened = nacl.secretbox.open(
        bytes.subarray(nacl.secretbox.nonceLength),
        bytes.subarray(0, nacl.secretbox.nonceLength),
        pairingCodeKey(code),
    );
    if (opened === null) throw new Error('pairing code payload failed authentication');
    return decodeUtf8(opened);
}
