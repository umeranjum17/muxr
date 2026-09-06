import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
    channelEntry, checksumLineMismatch, emptyCatalog, mergeCatalog, parseCatalog, publicDeadline, publicRecordMismatch,
    readPublicJson, requireRedirect, serializeCatalog,
} from '../../release/index.mjs';

// A nightly manifest in the shape the candidate workflow seals: a -nightly
// version, the development application identity so it installs beside the
// production app, and the APK digests the release actually carries.
const nightlyManifest = {
    schema: 1,
    release: { version: '0.1.28-nightly.1.1', appVersion: '0.1.28', channel: 'nightly', distTag: 'nightly', id: '0.1.28-nightly.1.1-2ba5483803d9' },
    source: { commit: '2ba5483803d9cf0d4421ef813491d1f28de3770c', tree: '2ab276b3a0188144071203274fce950d474dc167', dirty: false },
    build: { runId: '34034219166', runAttempt: '1' },
    artifacts: [
        { name: 'muxr-0.1.28-361.aab', bytes: 138332936, sha256: '56c9f635081c760219ad17de60851e88bd1646f711c2d6a22cb900f9283edc3b' },
        { name: 'muxr-0.1.28-361.apk', bytes: 176639520, sha256: 'e1a50185292c6fefcf6ccf069674957353116c0aae298114cee71131d25b8b76' },
    ],
    android: { applicationId: 'app.muxr.local.dev', versionCode: 361, signerSha256: '9c33841142483611257fcdf772f5e8fc30d6fac803f6da28e7eacfcaec12b08d' },
};
const record = (version, applicationId, npmDistTag) => ({
    version, appVersion: version.split('-')[0], tag: `v${version}`,
    releaseUrl: `https://github.com/umeranjum17/muxr/releases/tag/v${version}`,
    npmDistTag, publishedAt: '2026-09-06T13:17:22.000Z',
    manifestUrl: version === '0.1.25' ? null : `https://github.com/umeranjum17/muxr/releases/download/v${version}/release-manifest.json`,
    android: {
        url: `https://github.com/umeranjum17/muxr/releases/download/v${version}/muxr-android.apk`,
        sha256: 'c4dd3bd905658b79a58f1b28d919d89da0d3fb6c0b2fed6c7eb1a211f5c59305',
        bytes: 174880788, versionCode: 53, applicationId,
    },
});
// What the published catalog holds today: the legacy stable seed plus the two
// retired channels, which stay readable exactly as they were written.
const published = {
    schema: 1,
    channels: {
        stable: record('0.1.25', 'com.trymuxr.app', 'latest'),
        beta: record('0.1.27-beta.4.1', 'com.trymuxr.app', 'beta'),
        dev: record('0.1.27-dev.2.1', 'app.muxr.local.dev', 'dev'),
    },
};

const { channel, entry } = channelEntry({ tag: 'v0.1.28-nightly.1.1', manifest: nightlyManifest, publishedAt: '2026-09-06T13:17:22Z' });
assert.equal(channel, 'nightly');
assert.equal(entry.npmDistTag, 'nightly');
assert.equal(entry.appVersion, '0.1.28');
assert.equal(entry.android.applicationId, 'app.muxr.local.dev', 'nightly must keep the side-by-side application identity');
assert.equal(entry.android.url, 'https://github.com/umeranjum17/muxr/releases/download/v0.1.28-nightly.1.1/muxr-0.1.28-361.apk');
assert.equal(entry.manifestUrl, 'https://github.com/umeranjum17/muxr/releases/download/v0.1.28-nightly.1.1/release-manifest.json');

// Publishing nightly preserves every historical record untouched.
const parsed = parseCatalog(JSON.stringify(published));
assert.deepEqual(Object.keys(parsed.channels), ['stable', 'beta', 'dev']);
const next = mergeCatalog(parsed, channel, entry);
assert.deepEqual(next.channels.beta, published.channels.beta, 'publishing nightly disturbed the retired beta record');
assert.deepEqual(next.channels.dev, published.channels.dev, 'publishing nightly disturbed the retired dev record');
assert.deepEqual(next.channels.stable, published.channels.stable);
assert.equal(Object.keys(JSON.parse(serializeCatalog(next)).channels).join(','), 'stable,nightly,beta,dev');
const serialized = serializeCatalog(next);
assert.deepEqual(parseCatalog(serialized), next);
assert.equal(serializeCatalog(mergeCatalog(next, channel, entry)), serialized, 'republishing the same release was not idempotent');

// Retired channels are readable, never written; a retired name cannot be published.
assert.throws(() => mergeCatalog(next, 'beta', record('0.1.27-beta.5', 'com.trymuxr.app', 'beta')), /Only stable and nightly/);
assert.throws(() => mergeCatalog(next, 'nightly', { ...entry, version: '0.1.28-beta.1', tag: 'v0.1.28-beta.1' }), /invalid channel entry/i);
// A historical record that predates the dev/nightly split still classifies as beta.
assert.doesNotThrow(() => parseCatalog(JSON.stringify({ schema: 1, channels: { beta: record('0.1.26-rc.1', 'com.trymuxr.app', 'beta') } })));

// A channel never moves backwards, and a published version never changes bytes.
assert.throws(() => mergeCatalog(next, 'nightly', channelEntry({
    tag: 'v0.1.28-nightly.0.1',
    manifest: { ...nightlyManifest, release: { ...nightlyManifest.release, version: '0.1.28-nightly.0.1' } },
    publishedAt: '2026-09-06T10:00:00Z',
}).entry), /backwards/);
assert.throws(() => mergeCatalog(next, 'nightly', { ...entry, android: { ...entry.android, sha256: 'f'.repeat(64) } }), /different bytes/);
assert.throws(() => mergeCatalog(next, 'nightly', { ...entry, manifestUrl: null }), /invalid channel entry/i);
assert.throws(() => parseCatalog(JSON.stringify({ schema: 2, channels: {} })), /schema/);
assert.deepEqual(parseCatalog(''), emptyCatalog());

// Public routes must agree with the same record the catalog publishes.
const served = JSON.parse(JSON.stringify(entry));
assert.equal(publicRecordMismatch(entry, served, 'nightly'), undefined, 'an exact copy of the entry was rejected');
assert.equal(publicRecordMismatch(entry, { ...served, channel: 'nightly' }, 'nightly'), undefined);
assert.match(publicRecordMismatch(entry, { ...served, channel: 'stable' }, 'nightly'), /channel stable/);
assert.match(publicRecordMismatch(entry, { ...served, publishedAt: '2026-01-01T00:00:00.000Z' }, 'nightly'), /publishedAt/);
assert.match(publicRecordMismatch(entry, { ...served, android: { ...served.android, bytes: 1 } }, 'nightly'), /android.bytes/);
assert.match(publicRecordMismatch(entry, undefined, 'nightly'), /no record/);
const apkName = entry.android.url.split('/').pop();
assert.equal(checksumLineMismatch(entry, `${entry.android.sha256}  ${apkName}\n`), undefined);
assert.equal(checksumLineMismatch(entry, `# digests\n${entry.android.sha256} *${apkName}\n`), undefined);
assert.match(checksumLineMismatch(entry, `${'0'.repeat(64)}  ${apkName}\n`), /no line pairing/);
assert.match(checksumLineMismatch(entry, ''), /no checksums/);

// A public surface that serves a stale record before converging: the reader
// must wait it out against one shared deadline, and still fail past it rather
// than accept the stale answer. The raw catalog CDN behaves exactly like this.
const convergesAt = Date.now() + 1500;
const server = createServer((request, response) => {
    const converged = Date.now() >= convergesAt;
    if (request.url.startsWith('/api')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(converged ? served : { ...served, version: '0.1.27-beta.4.1' }));
        return;
    }
    response.writeHead(302, { location: converged ? entry.android.url : 'https://github.com/umeranjum17/muxr/releases/download/v0.1.27-beta.4.1/old.apk' });
    response.end();
});
try {
    await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
    const site = `http://127.0.0.1:${server.address().port}`;
    const deadline = publicDeadline(20_000);
    await readPublicJson(`${site}/api/releases/nightly`, { deadline, delayMs: 250, expect: (value) => publicRecordMismatch(entry, value, 'nightly') });
    const redirect = await requireRedirect(`${site}/downloads/nightly/android`, entry.android.url, { deadline, delayMs: 250 });
    assert.equal(redirect.status, 302);
    await assert.rejects(
        readPublicJson(`${site}/api/releases/nightly`, {
            deadline: publicDeadline(400),
            delayMs: 100,
            expect: () => 'never converges',
        }),
        /did not serve the expected record \(never converges\)/,
        'a surface that never converges was accepted',
    );
} finally { server.close(); }

process.stdout.write('release catalog flow passed\n');
