/**
 * Provider-neutral Surface offer contract (Slice 2A).
 *
 * One versioned `surface.offer` frame covers exactly three product targets:
 *
 * - Browser direct HTTPS: the phone's own WebView loads a public URL with
 *   phone-owned cookies. No host credential or profile is inherited.
 * - Browser host-local: a host-owned port plus an initial relative path, a
 *   human label and a worktree context. Never a naked device-chosen port: the
 *   port, provider and context a product lease dials always come from
 *   host-owned offer state, never from a phone-submitted field.
 * - Code review/navigation: a native Files/Changes/History target with a path
 *   and an optional line, range or revision. `mode: review` only; opening Code
 *   grants no editing authority.
 *
 * Every offer carries the semantic capability it needs
 * (`surface.browser.open`, `surface.browser.control-host-session` or
 * `surface.code.open`), placement intent only (never a pane id), a monotonic
 * revision per logical name, a bounded logical name and title, and an expiry.
 * The opaque offer handle is minted by the host, travels only inside the
 * encrypted control plane (or the owner-only local broker), and is never
 * displayed: CLI and agent output name the logical surface, never the handle.
 */

export const SURFACE_OFFER_VERSION = 1;

export const SURFACE_CAPABILITIES = [
    'surface.browser.open',
    'surface.browser.control-host-session',
    'surface.code.open',
] as const;
export type SurfaceCapability = (typeof SURFACE_CAPABILITIES)[number];

export function isSurfaceCapability(value: unknown): value is SurfaceCapability {
    return typeof value === 'string'
        && (SURFACE_CAPABILITIES as readonly string[]).includes(value);
}

export const SURFACE_PLACEMENTS = ['replace', 'beside', 'focus'] as const;
export type SurfacePlacement = (typeof SURFACE_PLACEMENTS)[number];

export const SURFACE_OFFER_KINDS = ['browser-direct', 'browser-local', 'code-review'] as const;
export type SurfaceOfferKind = (typeof SURFACE_OFFER_KINDS)[number];

export const MAX_SURFACE_NAME_LENGTH = 64;
export const MAX_SURFACE_TITLE_LENGTH = 120;
export const MAX_SURFACE_URL_LENGTH = 2048;
export const MAX_SURFACE_PATH_LENGTH = 1024;
export const MAX_SURFACE_LABEL_LENGTH = 120;
export const MAX_SURFACE_CONTEXT_LENGTH = 1024;
export const MAX_SURFACE_REVISION_TEXT = 40;

const SURFACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OFFER_HANDLE = /^sfo_[A-Za-z0-9_-]{8,128}$/;

export function isSurfaceOfferHandle(value: unknown): value is string {
    return typeof value === 'string' && OFFER_HANDLE.test(value);
}

const SURFACE_SESSION = /^[A-Za-z0-9._:-]{1,80}$/;

/** A bounded session scope. Never displayed; never a credential. */
export function isSurfaceSessionId(value: unknown): value is string {
    return typeof value === 'string' && SURFACE_SESSION.test(value);
}

/**
 * A session a companion may bind to: a live Agent Route, never an ephemeral
 * shell route. Checked against the live tree at open time, not just shaped.
 */
export function isPublishableSurfaceSession(value: unknown): value is string {
    return isSurfaceSessionId(value) && !(value as string).startsWith('shell:');
}

export interface SurfaceOfferBase {
    version: typeof SURFACE_OFFER_VERSION;
    capability: SurfaceCapability;
    /** Logical surface name. Bounded; never an internal id. */
    name: string;
    /** Human title. Bounded; defaults to the name. */
    title: string;
    /** Placement intent only. The host picks the pane, never the caller. */
    placement: SurfacePlacement;
    /** Monotonic per logical name. Replayed or rewound revisions fail closed. */
    revision: number;
    /** Epoch ms. Expired offers fail closed and never issue leases. */
    expiresAt: number;
    /**
     * Host-resolved claimant for the offer capability: the exact provider
     * the mobile must find approved and still claiming the capability
     * before it admits the surface. Never device-supplied in a product
     * lease; the phone names an offer handle and the host names the rest.
     */
    provider: string;
}

export interface SurfaceBrowserDirectOffer extends SurfaceOfferBase {
    kind: 'browser-direct';
    /** Public HTTPS URL. No credentials, no other scheme. */
    url: string;
}

export interface SurfaceBrowserLocalOffer extends SurfaceOfferBase {
    kind: 'browser-local';
    /** Host-owned loopback port. Resolved from host state, never device-chosen. */
    port: number;
    /** Initial relative path served by that port. Always relative. */
    path: string;
    /** Human label for the target. Bounded. */
    label: string;
    /** Worktree or working directory the target belongs to. Host-resolved. */
    context: string;
    /** Capability provider that registered the endpoint. Opaque to the kernel. */
    provider: string;
}

export interface SurfaceCodeReviewOffer extends SurfaceOfferBase {
    kind: 'code-review';
    /** Repo-relative path for native Files/Changes/History. */
    path: string;
    line?: number;
    column?: number;
    endLine?: number;
    /** Git revision for History/Diff targets. Bounded opaque text. */
    revisionText?: string;
    /**
     * Explicit native destination, set by the broker from the invoked
     * command: `code open` reviews a file, `code diff` reviews a delta.
     * Preserved end to end so the phone never infers intent from a
     * revision string. Review grants navigation only, never editing.
     */
    destination: 'file' | 'diff';
    /** Review grants navigation only, never editing. */
    mode: 'review';
}

export type SurfaceOffer = SurfaceBrowserDirectOffer | SurfaceBrowserLocalOffer | SurfaceCodeReviewOffer;

export type SurfaceOfferInput =
    | {
        kind: 'browser-direct';
        capability: 'surface.browser.open';
        name: string;
        title?: string;
        placement?: SurfacePlacement;
        url: string;
        provider: string;
    }
    | {
        kind: 'browser-local';
        capability: 'surface.browser.open' | 'surface.browser.control-host-session';
        name: string;
        title?: string;
        placement?: SurfacePlacement;
        port: number;
        path?: string;
        label: string;
        context: string;
        provider: string;
    }
    | {
        kind: 'code-review';
        capability: 'surface.code.open';
        name: string;
        title?: string;
        placement?: SurfacePlacement;
        path: string;
        line?: number;
        column?: number;
        endLine?: number;
        revisionText?: string;
        /** Explicit destination; the broker sets it from the invoked command. */
        destination?: 'file' | 'diff';
        provider: string;
    };

function cleanText(value: unknown, max: number, label: string): string {
    if (typeof value !== 'string') throw new Error(`surface offer ${label} must be text`);
    const clean = value.replace(/[\0-\x1F\x7F]/g, '').trim();
    if (clean === '' || clean.length > max || Buffer.byteLength(clean) > max * 4) {
        throw new Error(`surface offer ${label} is invalid`);
    }
    return clean;
}

function cleanName(value: unknown): string {
    if (typeof value !== 'string' || !SURFACE_NAME.test(value)) throw new Error('surface offer name is invalid');
    return value;
}

function cleanPlacement(value: unknown): SurfacePlacement {
    if (value === undefined) return 'replace';
    if (typeof value !== 'string' || !(SURFACE_PLACEMENTS as readonly string[]).includes(value)) {
        throw new Error('surface offer placement is invalid');
    }
    return value as SurfacePlacement;
}

function cleanPort(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error('surface offer port is invalid');
    }
    return value;
}

function cleanLine(value: unknown, label: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000_000) {
        throw new Error(`surface offer ${label} is invalid`);
    }
    return value;
}

function cleanDirectUrl(value: unknown): string {
    const raw = cleanText(value, MAX_SURFACE_URL_LENGTH, 'url');
    // The honest blank tab. The only non-HTTPS target: no host, no
    // credentials, nothing to leak, and no arbitrary site is ever chosen.
    if (raw === 'about:blank') return raw;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('surface offer url must be public HTTPS');
    }
    if (parsed.protocol !== 'https:') throw new Error('surface offer url must be public HTTPS');
    if (parsed.username !== '' || parsed.password !== '') throw new Error('surface offer url must not carry credentials');
    return parsed.toString();
}

function cleanRelativePath(value: unknown, label: string): string {
    const raw = cleanText(value, MAX_SURFACE_PATH_LENGTH, label);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.includes('\\')) {
        throw new Error(`surface offer ${label} must be a relative path`);
    }
    const stripped = raw.replace(/^\/+/, '');
    const parts = stripped.split('/');
    if (parts.some((part) => part === '..')) throw new Error(`surface offer ${label} must stay inside its target`);
    return stripped === '' ? '/' : `/${stripped}`;
}

function cleanCodePath(value: unknown): string {
    const raw = cleanText(value, MAX_SURFACE_PATH_LENGTH, 'path');
    if (raw.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.includes('\\')) {
        throw new Error('surface offer path must be repo-relative');
    }
    if (raw.split('/').some((part) => part === '..')) throw new Error('surface offer path must stay inside the worktree');
    return raw;
}

/**
 * Validate broker/device-supplied offer input before host state is read.
 * Returns the normalized input; the host assigns revision, expiry and handle.
 * Throws with a human-readable, id-free message on any violation.
 */
export function parseSurfaceOfferInput(value: unknown): SurfaceOfferInput {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('surface offer must be an object');
    }
    const input = value as Record<string, unknown>;
    const kind = input.kind;
    if (kind === 'browser-direct') {
        if (input.capability !== 'surface.browser.open') throw new Error('surface offer capability does not match its target');
        return {
            kind,
            capability: 'surface.browser.open',
            name: cleanName(input.name),
            ...(input.title === undefined ? {} : { title: cleanText(input.title, MAX_SURFACE_TITLE_LENGTH, 'title') }),
            ...(input.placement === undefined ? {} : { placement: cleanPlacement(input.placement) }),
            url: cleanDirectUrl(input.url),
            provider: cleanText(input.provider, MAX_SURFACE_NAME_LENGTH, 'provider'),
        };
    }
    if (kind === 'browser-local') {
        if (input.capability !== 'surface.browser.open' && input.capability !== 'surface.browser.control-host-session') {
            throw new Error('surface offer capability does not match its target');
        }
        return {
            kind,
            capability: input.capability,
            name: cleanName(input.name),
            ...(input.title === undefined ? {} : { title: cleanText(input.title, MAX_SURFACE_TITLE_LENGTH, 'title') }),
            ...(input.placement === undefined ? {} : { placement: cleanPlacement(input.placement) }),
            port: cleanPort(input.port),
            ...(input.path === undefined ? {} : { path: cleanRelativePath(input.path, 'path') }),
            label: cleanText(input.label, MAX_SURFACE_LABEL_LENGTH, 'label'),
            context: cleanText(input.context, MAX_SURFACE_CONTEXT_LENGTH, 'context'),
            provider: cleanText(input.provider, MAX_SURFACE_NAME_LENGTH, 'provider'),
        };
    }
    if (kind === 'code-review') {
        if (input.capability !== 'surface.code.open') throw new Error('surface offer capability does not match its target');
        const line = cleanLine(input.line, 'line');
        const column = cleanLine(input.column, 'column');
        const endLine = cleanLine(input.endLine, 'end line');
        if (endLine !== undefined && line !== undefined && endLine < line) {
            throw new Error('surface offer range is invalid');
        }
        const destination = input.destination ?? 'file';
        if (destination !== 'file' && destination !== 'diff') {
            throw new Error('surface offer destination is invalid');
        }
        return {
            kind,
            capability: 'surface.code.open',
            name: cleanName(input.name),
            ...(input.title === undefined ? {} : { title: cleanText(input.title, MAX_SURFACE_TITLE_LENGTH, 'title') }),
            ...(input.placement === undefined ? {} : { placement: cleanPlacement(input.placement) }),
            path: cleanCodePath(input.path),
            ...(line === undefined ? {} : { line }),
            ...(column === undefined ? {} : { column }),
            ...(endLine === undefined ? {} : { endLine }),
            ...(input.revisionText === undefined
                ? {}
                : { revisionText: cleanText(input.revisionText, MAX_SURFACE_REVISION_TEXT, 'revision') }),
            destination,
            provider: cleanText(input.provider, MAX_SURFACE_NAME_LENGTH, 'provider'),
        };
    }
    throw new Error('surface offer kind is invalid');
}

/** Capability an offer kind needs. The kernel never names a plugin id. */
export function surfaceCapabilityForKind(kind: SurfaceOfferKind): SurfaceCapability {
    if (kind === 'code-review') return 'surface.code.open';
    return 'surface.browser.open';
}

/**
 * Generic provider resolution over manifest-declared claimants.
 *
 * Order: an explicit claimant that is currently valid wins; otherwise a saved
 * claimant wins only when the caller supplies a reader for an existing saved
 * convention and that saved id is still valid; otherwise the sole
 * enabled-and-approved claimant wins. Missing or ambiguous providers fail
 * visibly with an id-free message. Claimants are opaque plugin ids supplied
 * by the caller from manifest capability declarations; nothing here names one.
 */
export function resolveSurfaceProvider(options: {
    capability: SurfaceCapability;
    claimants: readonly string[];
    explicit?: string;
    readSaved?: () => string | undefined;
}): string {
    const valid = new Set(options.claimants);
    if (options.explicit !== undefined) {
        if (!valid.has(options.explicit)) throw new Error('that surface provider is not enabled on this computer');
        return options.explicit;
    }
    const saved = options.readSaved?.();
    if (saved !== undefined && saved !== '' && valid.has(saved)) return saved;
    if (options.claimants.length === 0) throw new Error('no surface provider is enabled on this computer');
    if (options.claimants.length > 1) {
        throw new Error('more than one surface provider is enabled; choose one explicitly');
    }
    return options.claimants[0]!;
}
