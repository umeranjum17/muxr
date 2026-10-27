import { COMPACT_TAG, decodeCompactOffer, parseOffer, type PairOffer } from '@byokit/pair';
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

type OfferTerms = Pick<PairOffer, 'expires' | 'name' | 'role' | 'lifetime' | 'urls'>;

/** The terms of either offer form, read without the expiry check (callers compare `expires`); undefined when the text is neither. */
export function readOffer(scanned: string): OfferTerms | undefined {
    try {
        return parseOffer(scanned, 0);
    } catch {
        // Not v1: the kit's compact reader decides.
    }
    try {
        return decodeCompactOffer(scanned, 0);
    } catch {
        return undefined;
    }
}

/** A Tailscale address: a MagicDNS name, or the 100.64.0.0/10 range Tailscale
 *  hands out, which the kit's `describeRoute` files under "Private network". */
export function isTailscaleAddress(url: string): boolean {
    let host: string;
    try { host = new URL(url).hostname.toLowerCase(); }
    catch { return false; }
    const ip = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
    return host.endsWith('.ts.net') || (ip !== null && Number(ip[1]) >= 64 && Number(ip[1]) <= 127);
}

/** What to fix, in one sentence, when this device cannot reach the computer
 *  over Tailscale. `onTailscale` says whether this device holds a Tailscale
 *  address; where that is unknown (iOS, the web) both ends are named. */
export function tailscaleUnreachableMessage(computer: string, device: string, onTailscale?: boolean): string {
    if (onTailscale === false) return `Can't reach ${computer}: turn on Tailscale on this ${device} and sign in, then try again.`;
    if (onTailscale === true) return `Can't reach ${computer}: check it's awake and Tailscale is on there, signed in to the same account as this ${device}.`;
    return `Can't reach ${computer}. Is it awake and is Tailscale connected on this ${device} and the computer?`;
}

/**
 * A computer's one pairing link (`muxr link`): `http(s)://<address>/join#<secret>`,
 * pasted as is or opened through the app scheme as `muxr://join?to=<that link>`.
 * Returns the link itself; the secret stays in its fragment until pairing
 * redeems it for an offer (`redeemComputerLink`).
 */
export function computerLinkFrom(value: string): string | undefined {
    const input = value.replace(/\s+/g, '');
    let url: URL;
    try { url = new URL(input); } catch { return undefined; }
    if (['muxr:', 'muxr-dev:', 'muxr-preview:'].includes(url.protocol) && url.hostname === 'join') {
        const to = url.searchParams.get('to');
        return to === null || /^muxr/i.test(to) ? undefined : computerLinkFrom(to);
    }
    const web = url.protocol === 'http:' || url.protocol === 'https:';
    if (!web || url.hostname === '' || url.pathname !== '/join' || url.search || url.username || url.password) return undefined;
    return /^#[A-Za-z0-9_-]{43}$/.test(url.hash) ? input : undefined;
}

/** What to call the computer before pairing: its tailnet name's first label, or nothing for a bare address. */
export function computerLinkName(link: string): string | undefined {
    const host = new URL(link).hostname;
    return /^[0-9.]+$|^\[/.test(host) ? undefined : host.split('.')[0];
}

function isLinkOffer(value: string): boolean {
    return LINK_OFFER.test(value) || (isCompactOfferText(value) && readOffer(value) !== undefined);
}

export const LEGACY_PAIRING_CODE = 'This code came from muxr 0.2.0 or older. On the computer run npm i -g @trymuxr/cli@latest, then muxr pair.';

export const CUT_OFF_COMPUTER_LINK = 'This link is cut off. On your computer run muxr link and copy all of it.';

export const CUTOFF_PAIRING_CODE = 'This string is cut off. Copy all of it, or scan the QR.';

export const NOT_A_PAIRING_STRING = "That isn't a muxr pairing string. Open muxr on your computer, or run muxr pair, for a new one.";

export const EXPIRED_PAIRING_CODE = 'That pairing code has run out. Open muxr on your computer, or run muxr pair, for a new one.';

/** What `muxr pair` printed before the link offers: the only input that is genuinely an old version. */
const WS_LEGACY_CODE = /^wss?:\/\/[^?\s]+\?[^#\s]*\bpair=/i;

/** True only when the input decodes as an offer whose time has passed; undecodable input never counts as expired. */
export function linkOfferExpired(value: string): boolean {
    const offer = readOffer(value.replace(/\s+/g, ''));
    return offer !== undefined && offer.expires < Date.now();
}

export type PairingInputDecision
    = { ok: true; offer: string; link: string }
    | { ok: false; message: string; expired: boolean };

/**
 * One taxonomy for every pairing entry: the stripped offer when the input can
 * pair, otherwise the true reason in plain words. A wrapped or retyped
 * current code pairs once its whitespace is stripped; only the legacy relay
 * shape names an old version.
 *
 * `offer` is the inner token used to read the terms for display; `link` is the
 * value the pairing transport accepts. They differ for a browser link: web
 * pairing accepts only the full `https://…/pair#…` wrapper, so it is kept
 * whole. A native code, app-scheme link and compact code pair on `offer`.
 */
export function decidePairingInput(value: string): PairingInputDecision {
    const compact = value.replace(/\s+/g, '');
    const computer = computerLinkFrom(compact);
    if (computer !== undefined) return { ok: true, offer: computer, link: computer };
    if (/\/join#/.test(compact)) return { ok: false, message: CUT_OFF_COMPUTER_LINK, expired: false };
    // A deep link or pasted link wraps the offer in a URL; the terms are read
    // from the inner offer, while `link` keeps the wrapper for the HTTPS
    // browser form the web guard accepts.
    const decided = pairingTermsFromInput(compact);
    if (decided !== undefined) {
        const { offer, link } = decided;
        if (linkOfferExpired(offer)) return { ok: false, message: EXPIRED_PAIRING_CODE, expired: true };
        // Anything carrying the link tag that neither kit reader accepts is cut off.
        if (readOffer(offer) === undefined) return { ok: false, message: CUTOFF_PAIRING_CODE, expired: false };
        return { ok: true, offer, link };
    }
    if (WS_LEGACY_CODE.test(compact)) return { ok: false, message: LEGACY_PAIRING_CODE, expired: false };
    if (/byokit-link:/i.test(value)) return { ok: false, message: CUTOFF_PAIRING_CODE, expired: false };
    return { ok: false, message: NOT_A_PAIRING_STRING, expired: false };
}

/** A pairing this code can no longer finish: the next step is a new code from the computer, not a retry. */
export class PairingNeedsNewCode extends Error {}

/** Where a pairing offer came from: the OS redelivering a link intent, or the person typing, pasting, or scanning it. */
export type PairArrivalSource = 'intent' | 'user';

/** Unwrap only the registered app schemes or an http(s) /pair link; byokit validates the offer itself, and the wrapper's host is never dialed. Inner whitespace (terminal wrapping, retype gaps) is stripped: it can never be part of an offer. */
export function linkOfferFromUrl(value: string): string | undefined {
    return pairingTermsFromInput(value)?.offer;
}

/**
 * The inner offer plus the value pairing should receive. A browser link is a
 * wrapper — https for the web guard, plain http where the computer advertises
 * a ws:// relay (LAN self-host, a lab) — so `link` keeps it whole; an
 * app-scheme link or a bare code pairs on its inner `offer`, never the
 * wrapper.
 */
function pairingTermsFromInput(value: string): { offer: string; link: string } | undefined {
    const input = value.replace(/\s+/g, '');
    if (isLinkOffer(input)) return { offer: input, link: input };
    try {
        const url = new URL(input);
        const app = ['muxr:', 'muxr-dev:', 'muxr-preview:'].includes(url.protocol)
            && url.hostname === 'pair' && (url.pathname === '' || url.pathname === '/');
        // Plain http carries a browser link the same way: the offer rides in
        // the fragment and the offer's own ws:// addresses are what a phone
        // dials, so the scheme here is packaging, never trust. The web
        // platform keeps its https-wrapper guard in pairingPlatform.
        const web = (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '' && url.pathname === '/pair';
        if ((!app && !web) || url.username || url.password || url.search) return undefined;
        const offer = url.hash.slice(1);
        return isLinkOffer(offer) ? { offer, link: web ? input : offer } : undefined;
    } catch { return undefined; }
}

/** A byokit link offer QR (`byokit-link:1:…`), parsed for display only; @byokit/pair validates it. */
export function looksLikeLinkOffer(value: string): boolean {
    return linkOfferFromUrl(value) !== undefined;
}

export function looksLikePairingLink(value: string): boolean {
    return looksLikeLinkOffer(value) || computerLinkFrom(value) !== undefined || PAIR_LINK.test(value);
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
    if (input.length === 0) return { ok: false, error: 'Enter a pairing string. Open muxr on your computer, or run muxr pair, to get one.' };
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
        return { ok: false, error: 'This browser pairing link has no pairing code. Open muxr on your computer, or run muxr pair --browser, for a fresh one.' };
    }
    return { ok: false, error: 'This is not a muxr pairing string. Open muxr on your computer, or run muxr pair, for a fresh one.' };
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

function linkOfferDisplay(url: string): OfferTerms | undefined {
    return looksLikeLinkOffer(url) ? readOffer(url) : undefined;
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
