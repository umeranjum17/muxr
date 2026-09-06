import assert from 'node:assert/strict';
import {
    channelEntry, checksumLineMismatch, emptyCatalog, mergeCatalog, parseCatalog, publicRecordMismatch, serializeCatalog,
} from '../../release/index.mjs';

// The real sealed manifest of v0.1.27-beta.4.1, trimmed to the fields the
// catalog derives from. Deriving from the combined GitHub release manifest is
// the contract: the npm-only candidate manifest carries no Android identity.
const betaManifest = {
    schema: 1,
    release: { version: '0.1.27-beta.4.1', appVersion: '0.1.27', channel: 'beta', distTag: 'beta', id: '0.1.27-beta.4.1-2ba5483803d9' },
    source: { commit: '2ba5483803d9cf0d4421ef813491d1f28de3770c', tree: '2ab276b3a0188144071203274fce950d474dc167', dirty: false },
    build: { runId: '34034219166', runAttempt: '1' },
    artifacts: [
        { name: 'muxr-0.1.27-360.aab', bytes: 138332936, sha256: '56c9f635081c760219ad17de60851e88bd1646f711c2d6a22cb900f9283edc3b' },
        { name: 'muxr-0.1.27-360.apk', bytes: 176639520, sha256: 'e1a50185292c6fefcf6ccf069674957353116c0aae298114cee71131d25b8b76' },
        { name: 'trymuxr-cli-0.1.27-beta.4.1.tgz', bytes: 11615642, sha256: '14959d2298f80ddac5633ff8e2478edc5d411dffffffffffffffffffffffffff' },
    ],
    android: { applicationId: 'com.trymuxr.app', versionCode: 360, signerSha256: '9c33841142483611257fcdf772f5e8fc30d6fac803f6da28e7eacfcaec12b08d' },
};
// The one legacy stable entry, seeded before sealed manifests existed.
const legacyStable = {
    version: '0.1.25', appVersion: '0.1.25', tag: 'v0.1.25',
    releaseUrl: 'https://github.com/umeranjum17/muxr/releases/tag/v0.1.25',
    npmDistTag: 'latest', publishedAt: '2026-08-31T01:07:31.000Z', manifestUrl: null,
    android: {
        url: 'https://github.com/umeranjum17/muxr/releases/download/v0.1.25/muxr-android.apk',
        sha256: 'c4dd3bd905658b79a58f1b28d919d89da0d3fb6c0b2fed6c7eb1a211f5c59305',
        bytes: 174880788, versionCode: 53, applicationId: 'com.trymuxr.app',
    },
};

const { channel, entry } = channelEntry({ tag: 'v0.1.27-beta.4.1', manifest: betaManifest, publishedAt: '2026-09-06T13:17:22Z' });
assert.equal(channel, 'beta');
assert.equal(entry.npmDistTag, 'beta');
assert.equal(entry.appVersion, '0.1.27');
assert.equal(entry.releaseUrl, 'https://github.com/umeranjum17/muxr/releases/tag/v0.1.27-beta.4.1');
assert.equal(entry.manifestUrl, 'https://github.com/umeranjum17/muxr/releases/download/v0.1.27-beta.4.1/release-manifest.json');
assert.deepEqual(entry.android, {
    url: 'https://github.com/umeranjum17/muxr/releases/download/v0.1.27-beta.4.1/muxr-0.1.27-360.apk',
    sha256: 'e1a50185292c6fefcf6ccf069674957353116c0aae298114cee71131d25b8b76',
    bytes: 176639520, versionCode: 360, applicationId: 'com.trymuxr.app',
});

// Publishing one channel preserves the others and survives a round trip.
const seeded = mergeCatalog(emptyCatalog(), 'stable', legacyStable);
const published = mergeCatalog(seeded, channel, entry);
assert.deepEqual(published.channels.stable, legacyStable, 'publishing beta disturbed the stable entry');
assert.equal(published.channels.beta.version, '0.1.27-beta.4.1');
const serialized = serializeCatalog(published);
assert.deepEqual(parseCatalog(serialized), published);
assert.equal(serializeCatalog(mergeCatalog(published, channel, entry)), serialized, 'republishing the same release was not idempotent');

// A channel never moves backwards, and a published version never changes bytes.
assert.throws(() => mergeCatalog(published, 'beta', channelEntry({
    tag: 'v0.1.27-beta.3.1',
    manifest: { ...betaManifest, release: { ...betaManifest.release, version: '0.1.27-beta.3.1' } },
    publishedAt: '2026-09-06T10:00:00Z',
}).entry), /backwards/);
const tampered = { ...entry, android: { ...entry.android, sha256: 'f'.repeat(64) } };
assert.throws(() => mergeCatalog(published, 'beta', tampered), /different bytes/);

// Only the legacy stable seed may omit a manifest; anything else is rejected.
assert.throws(() => mergeCatalog(published, 'beta', { ...entry, manifestUrl: null }), /invalid channel entry/i);
assert.throws(() => parseCatalog(JSON.stringify({ schema: 2, channels: {} })), /schema/);
assert.deepEqual(parseCatalog(''), emptyCatalog());

// Public routes must agree with the same record the catalog publishes.
const served = JSON.parse(JSON.stringify(entry));
assert.equal(publicRecordMismatch(entry, served, 'beta'), undefined, 'an exact copy of the entry was rejected');
assert.equal(publicRecordMismatch(entry, { ...served, channel: 'beta' }, 'beta'), undefined);
assert.match(publicRecordMismatch(entry, { ...served, channel: 'dev' }, 'beta'), /channel dev/);
assert.match(publicRecordMismatch(entry, { ...served, publishedAt: '2026-01-01T00:00:00.000Z' }, 'beta'), /publishedAt/);
assert.match(publicRecordMismatch(entry, { ...served, android: { ...served.android, bytes: 1 } }, 'beta'), /android.bytes/);
assert.match(publicRecordMismatch(entry, undefined, 'beta'), /no record/);
const apkName = entry.android.url.split('/').pop();
assert.equal(checksumLineMismatch(entry, `${entry.android.sha256}  ${apkName}\n`), undefined);
assert.equal(checksumLineMismatch(entry, `# digests\n${entry.android.sha256} *${apkName}\n`), undefined);
assert.match(checksumLineMismatch(entry, `${'0'.repeat(64)}  ${apkName}\n`), /no line pairing/);
assert.match(checksumLineMismatch(entry, `${entry.android.sha256}  muxr-other.apk\n`), /no line pairing/);
assert.match(checksumLineMismatch(entry, ''), /no checksums/);

// The dev channel carries the separate development application identity.
assert.throws(() => mergeCatalog(published, 'dev', { ...entry, version: '0.1.27-dev.9.1', tag: 'v0.1.27-dev.9.1' }), /invalid channel entry/i);

process.stdout.write('release catalog flow passed\n');
