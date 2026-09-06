import { channelTags, compareVersions, distribution } from './channel.mjs';

/**
 * The public channel catalog: one small record per channel, pointing at the
 * immutable artifacts of the release that currently holds that channel.
 * Versioned releases are never retagged; only this pointer moves.
 */
export const CATALOG_BRANCH = 'release-channels';
export const CATALOG_PATH = 'channels.json';
export const CANONICAL_REPOSITORY = 'umeranjum17/muxr';
// The one legacy entry predating sealed manifests; every later release carries one.
const LEGACY_MANIFEST_EXEMPTION = Object.freeze({ channel: 'stable', version: '0.1.25' });
export const MANIFEST_ASSET = 'release-manifest.json';
// A dev build carries the separate development identity; nothing else may.
const CHANNEL_APPLICATION_ID = Object.freeze({ stable: 'com.trymuxr.app', beta: 'com.trymuxr.app', dev: 'app.muxr.local.dev' });

export function catalogUrl(repository = CANONICAL_REPOSITORY, branch = CATALOG_BRANCH) {
    return `https://raw.githubusercontent.com/${repository}/${branch}/${CATALOG_PATH}`;
}

export function releaseTag(version) {
    return `v${distribution(version).version}`;
}

export function assetUrl(repository, tag, name) {
    if (repository !== CANONICAL_REPOSITORY) throw new Error('Catalog URLs require the canonical repository');
    if (!/^v[0-9A-Za-z.-]{1,120}$/.test(tag) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) throw new Error('Invalid release asset identity');
    return `https://github.com/${repository}/releases/download/${tag}/${name}`;
}

export function emptyCatalog() {
    return { schema: 1, channels: {} };
}

function canonicalTimestamp(value) {
    const parsed = Date.parse(value ?? '');
    if (!Number.isFinite(parsed)) return undefined;
    return new Date(parsed).toISOString();
}

function validEntry(entry, channel) {
    if (!entry || typeof entry !== 'object') return false;
    const release = distribution(entry.version, channel);
    const android = entry.android;
    if (android === null || typeof android !== 'object' || entry.tag !== releaseTag(entry.version)) return false;
    const legacy = channel === LEGACY_MANIFEST_EXEMPTION.channel && entry.version === LEGACY_MANIFEST_EXEMPTION.version;
    const manifestExact = entry.manifestUrl === assetUrl(CANONICAL_REPOSITORY, entry.tag, MANIFEST_ASSET);
    const manifestAllowed = manifestExact || (entry.manifestUrl === null && legacy);
    const apkName = typeof android.url === 'string' ? android.url.split('/').pop() : '';
    return release.appVersion === entry.appVersion
        && entry.npmDistTag === channelTags[channel]
        && entry.releaseUrl === `https://github.com/${CANONICAL_REPOSITORY}/releases/tag/${entry.tag}`
        && manifestAllowed
        && entry.publishedAt === canonicalTimestamp(entry.publishedAt)
        && apkName.endsWith('.apk')
        && android.url === assetUrl(CANONICAL_REPOSITORY, entry.tag, apkName)
        && /^[0-9a-f]{64}$/.test(android.sha256 ?? '')
        && Number.isSafeInteger(android.bytes) && android.bytes > 0
        && Number.isSafeInteger(android.versionCode) && android.versionCode > 0
        && android.applicationId === CHANNEL_APPLICATION_ID[channel];
}

/** Builds one channel entry from a sealed release manifest; no rebuild, no guessing. */
export function channelEntry({ repository = CANONICAL_REPOSITORY, tag, manifest, publishedAt }) {
    if (manifest?.schema !== 1) throw new Error('Release manifest schema is not supported');
    const release = distribution(manifest.release?.version, manifest.release?.channel);
    if (tag !== releaseTag(release.version)) throw new Error('Release tag does not match its manifest version');
    if (manifest.release.distTag !== release.distTag) throw new Error('Release manifest dist-tag does not match its channel');
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    const apks = artifacts.filter((item) => item?.name?.endsWith('.apk'));
    if (apks.length !== 1) throw new Error('Exactly one Android APK artifact is required');
    const android = manifest.android;
    if (!android || !Number.isSafeInteger(android.versionCode) || typeof android.applicationId !== 'string') {
        throw new Error('Release manifest carries no Android build identity');
    }
    const entry = {
        version: release.version,
        appVersion: release.appVersion,
        tag,
        releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
        npmDistTag: release.distTag,
        publishedAt: canonicalTimestamp(publishedAt),
        manifestUrl: assetUrl(repository, tag, MANIFEST_ASSET),
        android: {
            url: assetUrl(repository, tag, apks[0].name),
            sha256: apks[0].sha256,
            bytes: apks[0].bytes,
            versionCode: android.versionCode,
            applicationId: android.applicationId,
        },
    };
    if (!validEntry(entry, release.channel)) throw new Error('Derived channel entry is invalid');
    return { channel: release.channel, entry };
}

export function parseCatalog(text) {
    if (text === undefined || text.trim() === '') return emptyCatalog();
    const catalog = JSON.parse(text);
    if (catalog?.schema !== 1 || !catalog.channels || typeof catalog.channels !== 'object') throw new Error('Unsupported channel catalog schema');
    for (const [channel, entry] of Object.entries(catalog.channels)) {
        if (!Object.hasOwn(channelTags, channel) || !validEntry(entry, channel)) throw new Error(`Invalid catalog entry: ${channel}`);
    }
    return { schema: 1, channels: { ...catalog.channels } };
}

/** Replaces one channel and preserves every other; never moves a channel backwards. */
export function mergeCatalog(catalog, channel, entry) {
    if (!Object.hasOwn(channelTags, channel)) throw new Error('Channel must be dev, beta or stable');
    if (!validEntry(entry, channel)) throw new Error('Refusing to publish an invalid channel entry');
    const current = catalog.channels[channel];
    if (current !== undefined) {
        const order = compareVersions(current.version, entry.version);
        if (order === undefined) throw new Error('Existing catalog version cannot be compared');
        if (order > 0) throw new Error(`Refusing to move ${channel} backwards from ${current.version} to ${entry.version}`);
        if (order === 0 && JSON.stringify(current) !== JSON.stringify(entry)) throw new Error('Published version already points at different bytes');
    }
    return { schema: 1, channels: { ...catalog.channels, [channel]: entry } };
}

export function serializeCatalog(catalog) {
    const channels = {};
    for (const channel of Object.keys(channelTags).sort()) {
        if (catalog.channels[channel] !== undefined) channels[channel] = catalog.channels[channel];
    }
    return `${JSON.stringify({ schema: 1, channels }, undefined, 2)}\n`;
}

/** Public surfaces must serve the catalog entry itself, field for field. */
export function publicRecordMismatch(entry, record, channel) {
    if (record === null || typeof record !== 'object') return 'served no record';
    if (record.channel !== undefined && record.channel !== channel) return `served channel ${record.channel}`;
    for (const field of ['version', 'appVersion', 'tag', 'releaseUrl', 'npmDistTag', 'publishedAt', 'manifestUrl']) {
        if (record[field] !== entry[field]) return `served ${field} ${JSON.stringify(record[field])}, expected ${JSON.stringify(entry[field])}`;
    }
    for (const field of ['url', 'sha256', 'bytes', 'versionCode', 'applicationId']) {
        if (record.android?.[field] !== entry.android[field]) return `served android.${field} ${JSON.stringify(record.android?.[field])}, expected ${JSON.stringify(entry.android[field])}`;
    }
    return undefined;
}

/** The checksum page must carry the APK's own digest line, not a summary. */
export function checksumLineMismatch(entry, text) {
    if (typeof text !== 'string' || text.trim() === '') return 'served no checksums';
    const name = entry.android.url.split('/').pop();
    for (const line of text.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 2) continue;
        if (parts[0] === entry.android.sha256 && parts[1].replace(/^\*/, '') === name) return undefined;
    }
    return `no line pairing ${entry.android.sha256} with ${name}`;
}
