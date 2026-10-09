import { COMPACT_TAG, decodeCompactOffer, parseOffer, type PairOffer } from '@byokit/link';
import { decodeBase64 } from '@/encryption/base64';

const UNSAFE_PAIRING_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * The camera reports every barcode in view, so the scanner needs a cheap way to
 * tell a pairing QR from a wifi code or a poster. It lives beside the parser
 * because the two have to agree: a shape this rejects never reaches pairing at
 * all, which the user sees as a scan that silently does nothing.
 *
 * Pre-link shapes stay recognizable so the classifier can name a genuinely
 * old relay code: anything carrying the current link tag but failing the
 * offer shape is a cut-off current code, never old.
 */
const PAIR_LINK = /^https:\/\/[^#]+\/pair#|^muxr:\/\/pair[?#]|^wss?:\/\/[^?\s]+\?[^#\s]*\bpair=|^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/pair#|^byokit-link:1:/i;
const LINK_OFFER = /^byokit-link:1:[A-Za-z0-9_-]+$/;

/**
 * A compact QR offer: the same pairing through one code entry, shown where
 * the full QR cannot fit. The tag comes from the kit, never copied here; the
 * kit stays the only parser of the bytes after it.
 */
export function isCompactOfferText(value: string): boolean {
    return value.startsWith(COMPACT_TAG);
}

function validCompactOffer(value: string): boolean {
    if (!isCompactOfferText(value)) return false;
    try {
        decodeCompactOffer(value);
        return true;
    } catch {
        return false;
    }
}

export const LEGACY_PAIRING_CODE = 'This code came from muxr 0.2.0 or older. On the computer run `npm i -g @trymuxr/cli@latest`, then `muxr pair`.';

export const CUTOFF_PAIRING_CODE = 'This string is cut off. Copy all of it, or scan the QR.';

export const NOT_A_PAIRING_STRING = "That isn't a muxr pairing string.";

export const EXPIRED_PAIRING_CODE = 'That pairing code has run out. Show a new one on your computer.';

/** What `muxr pair` printed before the link offers: the only input that is genuinely an old version. */
const WS_LEGACY_CODE = /^wss?:\/\/[^?\s]+\?[^#\s]*\bpair=/i;

/** True only when the input decodes as an offer whose time has passed; undecodable input never counts as expired. */
export function linkOfferExpired(value: string): boolean {
    const compact = value.replace(/\s+/g, '');
    try {
        return parseOffer(compact, 0).expires < Date.now();
    } catch {
        // A compact offer is not a v1 offer: ask the kit's compact reader.
    }
    try {
        return decodeCompactOffer(compact, 0).expires < Date.now();
    } catch {
        return false;
    }
}

export type PairingInputDecision
    = { ok: true; offer: string }
    | { ok: false; message: string; expired: boolean };

/**
 * One taxonomy for every pairing entry: the stripped offer when the input can
 * pair, otherwise the true reason in plain words. A wrapped or retyped
 * current code pairs once its whitespace is stripped; only the legacy relay
 * shape names an old version.
 */
export function decidePairingInput(value: string): PairingInputDecision {
    const compact = value.replace(/\s+/g, '');
    if (looksLikeLinkOffer(compact)) {
        // A deep link or pasted link wraps the offer in a URL; the pairing
        // itself needs the inner offer, never the wrapper.
        const offer = linkOfferFromUrl(compact) ?? compact;
        if (linkOfferExpired(offer)) return { ok: false, message: EXPIRED_PAIRING_CODE, expired: true };
        try {
            parseOffer(offer);
        } catch {
            // Not v1: a compact offer validates through the kit's reader, and
            // anything else carrying the link tag is cut off.
            if (!validCompactOffer(offer)) return { ok: false, message: CUTOFF_PAIRING_CODE, expired: false };
        }
        return { ok: true, offer };
    }
    if (WS_LEGACY_CODE.test(compact)) return { ok: false, message: LEGACY_PAIRING_CODE, expired: false };
    if (/byokit-link:/i.test(value)) return { ok: false, message: CUTOFF_PAIRING_CODE, expired: false };
    return { ok: false, message: NOT_A_PAIRING_STRING, expired: false };
}

/** A pairing this code can no longer finish: the next step is a new code from the computer, not a retry. */
export class PairingNeedsNewCode extends Error {}

/** Unwrap only the registered app schemes or an HTTPS /pair link; byokit validates the offer itself. Inner whitespace (terminal wrapping, retype gaps) is stripped: it can never be part of an offer. */
export function linkOfferFromUrl(value: string): string | undefined {
    const input = value.replace(/\s+/g, '');
    if (LINK_OFFER.test(input) || validCompactOffer(input)) return input;
    // expo-router hands a custom-scheme deep link to native-intent as a
    // path like `/pair#<offer>` (scheme stripped). Accept that form too.
    const hash = input.indexOf('#');
    if (hash >= 0) {
        const before = input.slice(0, hash);
        const offer = input.slice(hash + 1);
        if ((before === 'pair' || before === '/pair') && (LINK_OFFER.test(offer) || validCompactOffer(offer))) return offer;
    }
    try {
        const url = new URL(input);
        const app = ['muxr:', 'muxr-dev:', 'muxr-preview:'].includes(url.protocol)
            && url.hostname === 'pair' && (url.pathname === '' || url.pathname === '/');
        const web = url.protocol === 'https:' && url.hostname !== '' && url.pathname === '/pair';
        if ((!app && !web) || url.username || url.password || url.search) return undefined;
        const offer = url.hash.slice(1);
        return LINK_OFFER.test(offer) || validCompactOffer(offer) ? offer : undefined;
    } catch { return undefined; }
}

/** A byokit link offer QR (`byokit-link:1:…`), parsed for display only; @byokit/link validates it. */
export function looksLikeLinkOffer(value: string): boolean {
    return linkOfferFromUrl(value) !== undefined;
}

export function looksLikePairingLink(value: string): boolean {
    return looksLikeLinkOffer(value) || PAIR_LINK.test(value);
}

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
    if (input.length === 0) return { ok: false, error: 'Enter a pairing string from `muxr setup` or `muxr pair`.' };
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
        if (looksLikeLinkOffer(input) || hasPairingPayload(parsed)) return acceptPairing(input);
        return { ok: false, error: 'This browser pairing link has no pairing code. Create a fresh one with `muxr pair --browser`.' };
    }
    return { ok: false, error: 'This is not a muxr pairing string. Create a fresh one with `muxr setup` or `muxr pair`.' };
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

function linkOfferDisplay(url: string): PairOffer | undefined {
    if (!looksLikeLinkOffer(url)) return undefined;
    try { return parseOffer(url, 0); }
    catch { return undefined; }
}

function pairingAuthorityOf(url: string): PairingAuthority {
    if (linkOfferDisplay(url)?.role === 'view') return 'observe';
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
    const offerName = linkOfferDisplay(url)?.name;
    if (typeof offerName === 'string' && offerName.trim().length <= 60) return offerName.trim() || 'this machine';
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

export function linkOfferRole(value: string): 'control' | 'view' | undefined {
    const role = linkOfferDisplay(value)?.role;
    return role === 'control' || role === 'view' ? role : undefined;
}

export function hostedPairingDisplayName(url: string): string {
    return pairingDisplayNameOf(url);
}

export function hostedPairingDuration(url: string): string {
    const lifetime = linkOfferDisplay(url)?.lifetime;
    return (typeof lifetime === 'number' && lifetime > 8 * 60 * 60_000)
        || pairingSearchParams(url).get('personal') === '1' ? '30 days' : 'eight hours';
}
