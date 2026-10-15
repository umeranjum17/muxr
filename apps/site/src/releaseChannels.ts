/**
 * Release channel catalog: one published source of truth for what stable and
 * nightly currently are. The site never hardcodes a version or an APK name, so
 * a release is a catalog update rather than an edit spread across two repos.
 *
 * Beta and dev are retired. Their catalog records stay readable so links already
 * in the wild keep resolving, and once nightly is published they redirect to it.
 *
 * The publisher writes the catalog only after verifying the artifacts, so this
 * side treats it as untrusted input anyway: every field is checked, and every
 * URL must live under the muxr releases prefix so a compromised or malformed
 * catalog cannot turn our redirects into an open redirector.
 */

/** The channels the site offers. */
export const CHANNELS = ['stable', 'nightly'] as const;
export type Channel = (typeof CHANNELS)[number];
/** Retired channels: resolvable, never advertised. */
export const LEGACY_CHANNELS = ['beta', 'dev'] as const;
export type LegacyChannel = (typeof LEGACY_CHANNELS)[number];
export type CatalogChannel = Channel | LegacyChannel;
const CATALOG_CHANNELS: readonly CatalogChannel[] = [...CHANNELS, ...LEGACY_CHANNELS];

export const CATALOG_URL = 'https://raw.githubusercontent.com/umeranjum17/muxr/release-channels/channels.json';
const RELEASE_PREFIX = 'https://github.com/umeranjum17/muxr/releases/';
const TTL_MS = 20_000;
/** How long a validated catalog may still answer while refreshes fail. */
const GRACE_MS = 120_000;
const TIMEOUT_MS = 4_000;

export type AndroidArtifact = {
    url: string;
    sha256: string;
    bytes: number;
    versionCode: number;
    applicationId: string;
};

/** The Linux desktop app, once a release publishes one. */
export type LinuxArtifact = {
    url: string;
    sha256: string;
    bytes: number;
};

export type ChannelRelease = {
    version: string;
    appVersion: string;
    tag: string;
    releaseUrl: string;
    npmDistTag: string;
    publishedAt: string;
    /** Null only for the legacy stable release that predates manifests. */
    manifestUrl: string | null;
    android: AndroidArtifact;
    linux?: LinuxArtifact;
};

/** Channels that validated. A missing one is unavailable on its own. */
export type ReleaseCatalog = Partial<Record<CatalogChannel, ChannelRelease>>;

/** The catalog could not be read or did not validate. Never a stale version. */
export class ReleaseCatalogUnavailable extends Error {
    constructor(reason: string) {
        super(`release catalog unavailable: ${reason}`);
        this.name = 'ReleaseCatalogUnavailable';
    }
}

// The version grammar follows scripts/release/domain/channel.mjs; the channel
// each prerelease names is the one difference, because nightly is now its own
// channel rather than a spelling of dev. Every prerelease still resolves, so a
// version the publisher considers valid is never rejected here.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;
const PRERELEASE_CHANNEL: [RegExp, CatalogChannel][] = [[/^nightly(\.|-|$)/, 'nightly'], [/^dev(\.|-|$)/, 'dev']];
const DIST_TAG: Record<CatalogChannel, string> = { stable: 'latest', nightly: 'nightly', beta: 'beta', dev: 'dev' };
// Nightly carries the separate development identity, so it installs beside a
// stable app instead of replacing it.
const APPLICATION_ID: Record<CatalogChannel, string> = {
    stable: 'com.trymuxr.app', nightly: 'app.muxr.local.dev', beta: 'com.trymuxr.app', dev: 'app.muxr.local.dev',
};
const SHA256 = /^[0-9a-f]{64}$/;
const APK = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/;
const APPIMAGE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.AppImage$/;
const MANIFEST = 'release-manifest.json';
/** The one release that predates published manifests. */
const MANIFEST_EXEMPT = { channel: 'stable', version: '0.1.25' };

/** The version's own base and channel, by the publisher's rule. */
function classify(value: unknown): { appVersion: string; channel: CatalogChannel } {
    const match = typeof value === 'string' ? VERSION.exec(value) : null;
    if (match === null) throw new ReleaseCatalogUnavailable('invalid version');
    const prerelease = match[4];
    if (prerelease?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
        throw new ReleaseCatalogUnavailable('invalid prerelease number');
    }
    let channel: CatalogChannel = 'stable';
    if (prerelease !== undefined) channel = PRERELEASE_CHANNEL.find(([pattern]) => pattern.test(prerelease))?.[1] ?? 'beta';
    return { appVersion: `${match[1]}.${match[2]}.${match[3]}`, channel };
}

export function isChannel(value: string): value is CatalogChannel {
    return (CATALOG_CHANNELS as readonly string[]).includes(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ReleaseCatalogUnavailable(`${field} is not an object`);
    return value as Record<string, unknown>;
}

function exact(value: unknown, expected: string, field: string): string {
    if (value !== expected) throw new ReleaseCatalogUnavailable(`${field} must be ${expected}`);
    return expected;
}

function count(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ReleaseCatalogUnavailable(`invalid ${field}`);
    return value;
}

/**
 * A release asset URL is only ever the canonical immutable one for its own tag.
 * Everything is compared against a rebuilt string, so a query, a fragment or a
 * percent-encoded segment cannot smuggle a different destination through.
 */
function assetUrl(value: unknown, tag: string, filename: string, field: string): string {
    const expected = `${RELEASE_PREFIX}download/${tag}/${filename}`;
    if (typeof value !== 'string' || value !== expected) throw new ReleaseCatalogUnavailable(`${field} must be the canonical asset URL for ${tag}`);
    return expected;
}

function filenameOf(value: unknown, field: string, pattern = APK): string {
    if (typeof value !== 'string') throw new ReleaseCatalogUnavailable(`invalid ${field}`);
    const name = value.split('/').pop() ?? '';
    if (!pattern.test(name)) throw new ReleaseCatalogUnavailable(`invalid ${field} filename`);
    return name;
}

function sha256(value: unknown, field: string): string {
    if (typeof value !== 'string' || !SHA256.test(value)) throw new ReleaseCatalogUnavailable(`invalid ${field}`);
    return value;
}

/** The desktop download is optional: one that does not validate is left out, never the channel's phone app. */
function parseLinux(value: unknown, tag: string, channel: CatalogChannel): LinuxArtifact | undefined {
    if (value === undefined) return undefined;
    try {
        const linux = record(value, `${channel}.linux`);
        const field = `${channel}.linux.url`;
        return {
            url: assetUrl(linux.url, tag, filenameOf(linux.url, field, APPIMAGE), field),
            sha256: sha256(linux.sha256, `${channel}.linux.sha256`),
            bytes: count(linux.bytes, `${channel}.linux.bytes`),
        };
    } catch {
        return undefined;
    }
}

function parseRelease(value: unknown, channel: CatalogChannel): ChannelRelease {
    const entry = record(value, channel);
    const android = record(entry.android, `${channel}.android`);
    const version = entry.version as string;
    const classified = classify(version);
    if (classified.channel !== channel) throw new ReleaseCatalogUnavailable(`${channel}.version is a ${classified.channel} version`);
    const tag = exact(entry.tag, `v${version}`, `${channel}.tag`);
    const publishedAt = typeof entry.publishedAt === 'string' ? entry.publishedAt : '';
    if (publishedAt === '' || Number.isNaN(Date.parse(publishedAt))) throw new ReleaseCatalogUnavailable(`invalid ${channel}.publishedAt`);
    const bootstrap = channel === MANIFEST_EXEMPT.channel && version === MANIFEST_EXEMPT.version;
    if (entry.manifestUrl === null && !bootstrap) throw new ReleaseCatalogUnavailable(`${channel}.manifestUrl is required`);
    return {
        version,
        appVersion: exact(entry.appVersion, classified.appVersion, `${channel}.appVersion`),
        tag,
        releaseUrl: exact(entry.releaseUrl, `${RELEASE_PREFIX}tag/${tag}`, `${channel}.releaseUrl`),
        npmDistTag: exact(entry.npmDistTag, DIST_TAG[channel], `${channel}.npmDistTag`),
        publishedAt,
        manifestUrl: entry.manifestUrl === null ? null : assetUrl(entry.manifestUrl, tag, MANIFEST, `${channel}.manifestUrl`),
        android: {
            url: assetUrl(android.url, tag, filenameOf(android.url, `${channel}.android.url`), `${channel}.android.url`),
            sha256: sha256(android.sha256, `${channel}.android.sha256`),
            bytes: count(android.bytes, `${channel}.android.bytes`),
            versionCode: count(android.versionCode, `${channel}.android.versionCode`),
            applicationId: exact(android.applicationId, APPLICATION_ID[channel], `${channel}.android.applicationId`),
        },
        linux: parseLinux(entry.linux, tag, channel),
    };
}

export function parseCatalog(payload: unknown): ReleaseCatalog {
    const root = record(payload, 'catalog');
    if (root.schema !== 1) throw new ReleaseCatalogUnavailable('unsupported schema');
    const channels = record(root.channels, 'channels');
    const parsed: ReleaseCatalog = {};
    for (const channel of CATALOG_CHANNELS) {
        // The publisher writes one channel per publication, so a catalog with
        // only stable is normal rather than broken. A channel that is absent or
        // does not validate is unavailable by itself; the rest still serve.
        if (channels[channel] === undefined) continue;
        try { parsed[channel] = parseRelease(channels[channel], channel); }
        catch { /* that channel stays unavailable */ }
    }
    return parsed;
}

/** The APK filename as published, taken from the URL rather than rebuilt. */
export function apkFilename(release: ChannelRelease): string {
    const name = release.android.url.split('/').pop() ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/.test(name)) throw new ReleaseCatalogUnavailable('invalid android filename');
    return name;
}

type CatalogResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type CatalogFetch = (url: string, init: { signal: AbortSignal }) => Promise<CatalogResponse>;

/** Server-side cache: one short-TTL read shared by every visitor. */
export class ReleaseChannels {
    readonly #url: string;
    readonly #fetch: CatalogFetch;
    readonly #ttlMs: number;
    readonly #graceMs: number;
    readonly #timeoutMs: number;
    readonly #now: () => number;
    #cached: { at: number; catalog: ReleaseCatalog } | undefined;
    #inflight: Promise<ReleaseCatalog> | undefined;

    constructor(options: { url?: string; fetch?: CatalogFetch; ttlMs?: number; graceMs?: number; timeoutMs?: number; now?: () => number } = {}) {
        this.#url = options.url ?? CATALOG_URL;
        this.#fetch = options.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<CatalogResponse>);
        this.#ttlMs = options.ttlMs ?? TTL_MS;
        this.#graceMs = options.graceMs ?? GRACE_MS;
        this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
        this.#now = options.now ?? Date.now;
    }

    async catalog(): Promise<ReleaseCatalog> {
        const cached = this.#cached;
        if (cached !== undefined && this.#now() - cached.at < this.#ttlMs) return cached.catalog;
        this.#inflight ??= this.#load().finally(() => { this.#inflight = undefined; });
        try {
            return await this.#inflight;
        } catch (error) {
            // A brief refresh failure may still answer from the last validated
            // catalog; past the grace window an old release stops being called
            // current and the channel reports unavailable instead.
            if (cached !== undefined && this.#now() - cached.at < this.#graceMs) return cached.catalog;
            throw error;
        }
    }

    async #load(): Promise<ReleaseCatalog> {
        let payload: unknown;
        // raw.githubusercontent.com caches a branch URL for minutes, which would
        // hold a finished release behind stale CDN metadata. A bounded bucket
        // gives each TTL window its own cache key without unbounded cardinality.
        const bucket = Math.floor(this.#now() / this.#ttlMs);
        const target = `${this.#url}${this.#url.includes('?') ? '&' : '?'}t=${bucket}`;
        try {
            const response = await this.#fetch(target, { signal: AbortSignal.timeout(this.#timeoutMs) });
            if (!response.ok) throw new ReleaseCatalogUnavailable(`http ${response.status}`);
            payload = await response.json();
        } catch (error) {
            if (error instanceof ReleaseCatalogUnavailable) throw error;
            throw new ReleaseCatalogUnavailable(error instanceof Error ? error.message : String(error));
        }
        const catalog = parseCatalog(payload);
        this.#cached = { at: this.#now(), catalog };
        return catalog;
    }
}
