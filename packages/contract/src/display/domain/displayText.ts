export const MAX_DISPLAY_BYTES = 4 * 1024;

/**
 * Trim a display string to `maxBytes` of UTF-8, never splitting a code point.
 * Used by the host to bound Herdr workspace tokens and by the mobile usage
 * parsers. Pure JS so both sides can share it.
 */
export function capUtf8Bytes(text: string, maxBytes: number): string {
    if (maxBytes <= 0 || text.length === 0) return '';
    let bytes = 0;
    let index = 0;
    while (index < text.length) {
        const codePoint = text.codePointAt(index)!;
        let size = 1;
        if (codePoint > 0xffff) size = 4;
        else if (codePoint > 0x7ff) size = 3;
        else if (codePoint > 0x7f) size = 2;
        if (bytes + size > maxBytes) break;
        bytes += size;
        index += codePoint > 0xffff ? 2 : 1;
    }
    return text.slice(0, index);
}

// C0 controls (keeping tab/newline/carriage return), DEL, zero-width chars,
// bidi overrides, and the BOM. Strip before any untrusted text renders.
const DISPLAY_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200C\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function sanitizeDisplayText(text: string): string {
    return text.replace(DISPLAY_CONTROL, '');
}

export type ScreenTone = 'primary' | 'secondary' | 'positive' | 'warning' | 'danger';
