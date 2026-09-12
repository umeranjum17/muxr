import { PAIRING_CODE_ALPHABET } from '@muxr/crypto';
import { decodeBase64 } from '@/encryption/base64';

const UNSAFE_PAIRING_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function pairingSearchParams(url: string): URLSearchParams {
    const paramsStart = url.search(/[?#]/);
    return new URLSearchParams(paramsStart >= 0 ? url.slice(paramsStart + 1) : '');
}

function isDevelopmentLoopback(parsed: URL): boolean {
    return typeof __DEV__ !== 'undefined' && __DEV__
        && parsed.protocol === 'http:'
        && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
}

function isWebsocketPairing(parsed: URL): boolean {
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
}

function isMuxrPairScheme(parsed: URL): boolean {
    return parsed.protocol === 'muxr:' && parsed.hostname === 'pair';
}

function isBrowserPairPath(parsed: URL): boolean {
    return (parsed.protocol === 'https:' || isDevelopmentLoopback(parsed)) && parsed.pathname === '/pair';
}

function onlyPairQuery(parsed: URL): boolean {
    const codes = parsed.searchParams.getAll('pair');
    const emptyPath = parsed.pathname === '' || parsed.pathname === '/';
    return emptyPath
        && parsed.hash === ''
        && codes.length === 1
        && codes[0] !== ''
        && [...parsed.searchParams.keys()].every((key) => key === 'pair');
}

function wellFormedBrowserPairQuery(parsed: URL): boolean {
    const codes = parsed.searchParams.getAll('pair');
    const role = parsed.searchParams.get('role');
    const knownKeys = [...parsed.searchParams.keys()].every((key) => key === 'pair' || key === 'role' || key === 'personal');
    return codes.length === 1
        && codes[0] !== ''
        && (role === 'control' || role === 'observe')
        && knownKeys
        && parsed.hash === '';
}

function hasPairingPayload(parsed: URL): boolean {
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    return parsed.searchParams.has('payload')
        || parsed.searchParams.get('v') === '2'
        || fragment.has('payload')
        || fragment.get('v') === '2';
}

function compactPairingRecord(compact: string | null): Record<string, unknown> | undefined {
    if (!compact) return undefined;
    try {
        return JSON.parse(new TextDecoder().decode(decodeBase64(compact, 'base64url'))) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

export function expandCompactPairingPayload(fragment: URLSearchParams): void {
    const compact = fragment.get('payload');
    if (compact === null) return;
    const decoded = compactPairingRecord(compact);
    if (decoded === undefined) throw new Error('pairing link payload is invalid');
    for (const [key, value] of Object.entries(decoded)) {
        if (typeof value === 'string') fragment.set(key, value);
    }
}

export type PairingAuthority = 'control' | 'observe';

export type PairingString = {
    readonly url: string;
    readonly authority: PairingAuthority;
    readonly displayName: string;
};

export type PairingStringParse =
    | { ok: true; pairing: PairingString }
    | { ok: false; error: string };

function pairingUrlOrReject(value: string): PairingStringParse {
    // Ordinary ASCII whitespace is wrapping from terminals; strip it while
    // still rejecting control and bidi spoofing characters.
    const input = value.trim().replace(/[ \t\r\n]+/g, '');
    if (input.length === 0) return { ok: false, error: 'Enter a pairing string from muxr setup or muxr pair.' };
    if (input.length > 65_536) return { ok: false, error: 'This pairing string is too large. Create a fresh one on the computer.' };
    if (UNSAFE_PAIRING_TEXT.test(input)) {
        return { ok: false, error: 'This pairing string contains hidden control characters. Create a fresh one and scan or paste it exactly.' };
    }

    let parsed: URL;
    try { parsed = new URL(input); }
    catch { return { ok: false, error: 'This pairing string is not a valid URL. Create a fresh one on the computer.' }; }
    if (parsed.username !== '' || parsed.password !== '') {
        return { ok: false, error: 'Unsafe pairing string: text before “@” is treated as login information, not as part of the computer name. muxr did not connect. Create a fresh pairing code and scan or paste it exactly.' };
    }
    if (parsed.hostname === '') return { ok: false, error: 'This pairing string has no relay address. Create a fresh one on the computer.' };

    if (isWebsocketPairing(parsed)) {
        if (!onlyPairQuery(parsed)) {
            return { ok: false, error: 'This short pairing string is malformed. Create a fresh one on the computer.' };
        }
        return acceptPairing(input);
    }
    if (isMuxrPairScheme(parsed)) return acceptPairing(input);
    if (isBrowserPairPath(parsed)) {
        if (parsed.searchParams.getAll('pair').length > 0) {
            if (!wellFormedBrowserPairQuery(parsed)) {
                return { ok: false, error: 'This short browser pairing link is malformed. Create a fresh one on the computer.' };
            }
            return acceptPairing(input);
        }
        if (hasPairingPayload(parsed)) return acceptPairing(input);
        return { ok: false, error: 'This browser pairing link has no pairing code. Create a fresh one with muxr pair --browser.' };
    }
    return { ok: false, error: 'This is not a muxr pairing string. Create a fresh one with muxr setup or muxr pair.' };
}

function acceptPairing(url: string): PairingStringParse {
    return { ok: true, pairing: { url, authority: pairingAuthorityOf(url), displayName: pairingDisplayNameOf(url) } };
}

export function parsePairingString(value: string): PairingStringParse {
    return pairingUrlOrReject(value);
}

/** Validate pairing input before confirmation or network access. */
export function prepareHostedPairingInput(value: string): string {
    const parsed = parsePairingString(value);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.pairing.url;
}

function pairingAuthorityOf(url: string): PairingAuthority {
    const fragment = pairingSearchParams(url);
    const direct = fragment.get('role') ?? fragment.get('authority');
    if (direct === 'control' || direct === 'observe') return direct;
    const decoded = compactPairingRecord(fragment.get('payload'));
    const authority = decoded?.authority;
    if (authority === 'control' || authority === 'observe') return authority;
    // Unknown consent copy must never understate authority.
    return 'control';
}

function pairingDisplayNameOf(url: string): string {
    const fragment = pairingSearchParams(url);
    let name = fragment.get('name')?.trim();
    if (!name) {
        const decoded = compactPairingRecord(fragment.get('payload'));
        if (typeof decoded?.name === 'string') name = decoded.name.trim();
    }
    return name && name.length <= 120 ? name : 'this machine';
}

export function hostedPairingAuthority(url: string): PairingAuthority {
    return pairingAuthorityOf(url);
}

export function hostedPairingDisplayName(url: string): string {
    return pairingDisplayNameOf(url);
}

/**
 * The lifetime the link asks for. Personal browser grants (`--browser-personal`)
 * last 30 days; every other browser grant eight hours. The host mints the
 * real expiry, so confirmed copy reads the grant, not this.
 */
export function hostedPairingLifetime(url: string): 'eight hours' | '30 days' {
    const fragment = pairingSearchParams(url);
    if (fragment.get('personal') === '1') return '30 days';
    const decoded = compactPairingRecord(fragment.get('payload'));
    return decoded?.personal === true ? '30 days' : 'eight hours';
}

export type BrowserPairingQr = {
    readonly url: string;
    /** Normalized destination origin (ASCII host, explicit non-default port). */
    readonly origin: string;
    readonly authority: PairingAuthority;
    readonly personal: boolean;
};

export type BrowserPairingQrParse =
    | { ok: true; qr: BrowserPairingQr }
    | { ok: false; error: string };

const BROWSER_QR_KEYS = ['pair', 'role', 'personal'];
// The computer prints the code as XXXXX-XXXXX; the undashed form is the same code.
const BROWSER_QR_CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{5}-?[${PAIRING_CODE_ALPHABET}]{5}$`);
const NOT_A_BROWSER_QR = 'This is not a browser pairing QR from muxr. Run muxr pair --browser on your computer and scan the QR it shows.';
const NATIVE_QR = 'This QR is for the native app. Run muxr pair --browser on your computer for a browser QR.';

/**
 * Accept only the short browser invitation the computer prints
 * (`https://host/pair?pair=CODE&role=control|observe[&personal=1]`) before
 * anything reads it. Native/enrollment/arbitrary QR values are rejected with
 * a static message: the scanned text is never echoed.
 */
export function parseBrowserPairingQr(value: unknown): BrowserPairingQrParse {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return { ok: false, error: NOT_A_BROWSER_QR };
    if (/^(wss?|muxr):\/\//i.test(value)) return { ok: false, error: NATIVE_QR };
    if (UNSAFE_PAIRING_TEXT.test(value) || /\s/.test(value)) return { ok: false, error: NOT_A_BROWSER_QR };
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { return { ok: false, error: NOT_A_BROWSER_QR }; }
    const shape = parsed.protocol === 'https:' && parsed.pathname === '/pair' && parsed.hostname !== ''
        && parsed.username === '' && parsed.password === '' && parsed.hash === '';
    if (!shape) return { ok: false, error: NOT_A_BROWSER_QR };
    const keys = [...parsed.searchParams.keys()];
    if (keys.length !== new Set(keys).size || keys.some((key) => !BROWSER_QR_KEYS.includes(key))) return { ok: false, error: NOT_A_BROWSER_QR };
    const code = parsed.searchParams.get('pair') ?? '';
    const role = parsed.searchParams.get('role');
    const personal = parsed.searchParams.get('personal');
    if (!BROWSER_QR_CODE.test(code) || (role !== 'control' && role !== 'observe')) return { ok: false, error: NOT_A_BROWSER_QR };
    if (personal !== null && personal !== '1') return { ok: false, error: NOT_A_BROWSER_QR };
    return { ok: true, qr: { url: value, origin: parsed.origin, authority: role, personal: personal === '1' } };
}
