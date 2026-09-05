import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { distribution } from '../domain/channel.mjs';
import { artifactPath, digestFile, packedMetadata, sourceRevision } from '../infrastructure/artifacts.mjs';

/** Seal existing build outputs; never rebuild while sealing or promoting. */
export async function sealRelease({ directory, version, channel, files, runId, runAttempt = '1', sourceRoot = process.cwd(), android }) {
    const release = distribution(version, channel);
    const source = sourceRevision(sourceRoot);
    if (source.dirty) throw new Error('Release sealing requires a clean source checkout');
    if (!/^[1-9]\d{0,19}$/.test(String(runId)) || !/^[1-9]\d{0,5}$/.test(String(runAttempt))) throw new Error('Invalid build run identity');
    if (!Array.isArray(files) || files.length < 1 || files.length > 16 || new Set(files).size !== files.length) throw new Error('Invalid release artifact list');
    const artifacts = [];
    for (const name of files) {
        const path = artifactPath(directory, name);
        const item = { name, bytes: statSync(path).size, sha256: await digestFile(path) };
        if (name.endsWith('.tgz')) {
            const pkg = packedMetadata(path);
            if (pkg.version !== version || pkg.muxrRelease?.commit !== source.commit || pkg.muxrRelease?.sourceTree !== source.tree
                || pkg.muxrRelease?.sourceDirty !== false || pkg.muxrRelease?.channel !== release.channel) throw new Error('npm tarball does not match the clean release source and channel');
        }
        artifacts.push(item);
    }
    const manifest = { schema: 1, release: { ...release, id: `${version}-${source.commit.slice(0, 12)}` }, source,
        build: { runId: String(runId), runAttempt: String(runAttempt) }, artifacts };
    if (android !== undefined) {
        if (!['com.trymuxr.app', 'app.muxr.local.dev', 'app.muxr.local.preview'].includes(android.applicationId)
            || !Number.isSafeInteger(android.versionCode) || android.versionCode < 1 || android.versionCode > 2100000000
            || !/^[0-9a-f]{64}$/.test(android.signerSha256)) throw new Error('Invalid Android build identity');
        manifest.android = android;
    }
    writeFileSync(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return manifest;
}
