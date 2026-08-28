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
    const knownKeys = [...parsed.searchParams.keys()].every((key) => key === 'pair' || key === 'role');
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

/** Validate pairing input before confirmation or network access. */
export function prepareHostedPairingInput(value: string): string {
    // Ordinary ASCII whitespace is wrapping from terminals; strip it while
    // still rejecting control and bidi spoofing characters.
    const input = value.trim().replace(/[ \t\r\n]+/g, '');
    if (input.length === 0) throw new Error('Enter a pairing string from `muxr setup` or `muxr pair`.');
    if (input.length > 65_536) throw new Error('This pairing string is too large. Create a fresh one on the computer.');
    if (UNSAFE_PAIRING_TEXT.test(input)) throw new Error('This pairing string contains hidden control characters. Create a fresh one and scan or paste it exactly.');

    let parsed: URL;
    try { parsed = new URL(input); }
    catch { throw new Error('This pairing string is not a valid URL. Create a fresh one on the computer.'); }
    if (parsed.username !== '' || parsed.password !== '') {
        throw new Error('Unsafe pairing string: text before “@” is treated as login information, not as part of the computer name. muxr did not connect. Create a fresh pairing code and scan or paste it exactly.');
    }
    if (parsed.hostname === '') throw new Error('This pairing string has no relay address. Create a fresh one on the computer.');

    if (isWebsocketPairing(parsed)) {
        if (!onlyPairQuery(parsed)) {
            throw new Error('This short pairing string is malformed. Create a fresh one on the computer.');
        }
        return input;
    }
    if (isMuxrPairScheme(parsed)) return input;
    if (isBrowserPairPath(parsed)) {
        if (parsed.searchParams.getAll('pair').length > 0) {
            if (!wellFormedBrowserPairQuery(parsed)) {
                throw new Error('This short browser pairing link is malformed. Create a fresh one on the computer.');
            }
            return input;
        }
        if (hasPairingPayload(parsed)) return input;
        throw new Error('This browser pairing link has no pairing code. Create a fresh one with `muxr pair --browser`.');
    }
    throw new Error('This is not a muxr pairing string. Create a fresh one with `muxr setup` or `muxr pair`.');
}

export function hostedPairingAuthority(url: string): 'control' | 'observe' {
    const fragment = pairingSearchParams(url);
    const direct = fragment.get('role') ?? fragment.get('authority');
    if (direct === 'control' || direct === 'observe') return direct;
    const decoded = compactPairingRecord(fragment.get('payload'));
    const authority = decoded?.authority;
    if (authority === 'control' || authority === 'observe') return authority;
    // Unknown consent copy must never understate authority.
    return 'control';
}

export function hostedPairingDisplayName(url: string): string {
    const fragment = pairingSearchParams(url);
    let name = fragment.get('name')?.trim();
    if (!name) {
        const decoded = compactPairingRecord(fragment.get('payload'));
        if (typeof decoded?.name === 'string') name = decoded.name.trim();
    }
    return name && name.length <= 120 ? name : 'this machine';
}
