export const MAX_DISPLAY_STDOUT_BYTES = 64 * 1024;
export const MAX_DISPLAY_STDERR_BYTES = 256 * 1024;
/** Per-string transport cap; ordinary text nodes apply the smaller display cap. */
export const MAX_DISPLAY_RESULT_STRING_BYTES = MAX_DISPLAY_STDOUT_BYTES;
export const MAX_DISPLAY_BYTES = 4 * 1024;
export const MAX_DISPLAY_DEPTH = 8;
export const MAX_DISPLAY_ARRAY_ENTRIES = 256;
/** A bounded user-visible manifest string. Plain strings remain the default-compatible form. */
export type DisplayText = string | {
    default: string;
    translations: Record<string, string>;
};

export function defaultDisplayText(value: DisplayText): string {
    return typeof value === 'string' ? value : value.default;
}

/** Pure locale resolution shared by mobile renderers, config generation, and tests. */
export function resolveDisplayText(value: DisplayText, language: string): string {
    if (typeof value === 'string') return value;
    const entries = Object.entries(value.translations);
    const exact = entries.find(([locale]) => locale.toLowerCase() === language.toLowerCase())?.[1];
    if (exact !== undefined) return exact;
    const base = language.split('-')[0]!.toLowerCase();
    return entries.find(([locale]) => locale.toLowerCase() === base)?.[1] ?? value.default;
}

/**
 * Trim a display string to `maxBytes` of UTF-8, never splitting a code point.
 * Used by the host before RPC output reaches mobile and defensively in mobile
 * rendering (`bindText`/`displayText`). Pure JS so both sides can share it.
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

/** Bound and sanitize untrusted plugin results before they cross a UI boundary. */
export function boundDisplayValue(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return capUtf8Bytes(sanitizeDisplayText(value), MAX_DISPLAY_RESULT_STRING_BYTES);
    if (value === null) return null;
    if (depth >= MAX_DISPLAY_DEPTH) return undefined;
    if (Array.isArray(value)) return value.slice(0, MAX_DISPLAY_ARRAY_ENTRIES).map((entry) => boundDisplayValue(entry, depth + 1));
    if (typeof value !== 'object') return value;
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
        const bounded = boundDisplayValue(entry, depth + 1);
        if (bounded !== undefined) out[key] = bounded;
    }
    return out;
}


export type ScreenTone = 'primary' | 'secondary' | 'positive' | 'warning' | 'danger';
