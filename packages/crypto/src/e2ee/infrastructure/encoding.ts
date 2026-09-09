// Attachment frames run to megabytes, where a per-byte string concat costs
// seconds on Hermes. Buffer when it exists (node host), chunked otherwise.
const BASE64_CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK) as unknown as number[]);
    }
    return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
    // atob (the web path) throws on '-' and '_': base64url keys must be
    // normalized before decoding or every E2EE frame fails silently on web.
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(normalized, 'base64'));
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}
