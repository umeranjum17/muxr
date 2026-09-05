import { statSync } from 'node:fs';
import { distribution } from '../domain/channel.mjs';
import { artifactPath, digestFile, packedMetadata, readReleaseManifest } from '../infrastructure/artifacts.mjs';

/** Verification is read-only. Registry/store writes belong to promotion jobs. */
export async function verifyRelease({ directory, commit, version, channel, runId, runAttempt }) {
    if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('An exact expected source commit is required');
    const expected = distribution(version, channel);
    const manifest = readReleaseManifest(directory);
    if (manifest.schema !== 1 || manifest.source?.commit !== commit || manifest.source?.dirty !== false
        || !/^[0-9a-f]{40}$/.test(manifest.source?.tree ?? '') || manifest.release?.version !== expected.version
        || manifest.release?.channel !== expected.channel || manifest.release?.distTag !== expected.distTag
        || !/^[1-9]\d{0,5}$/.test(manifest.build?.runAttempt ?? '')
        || (runAttempt !== undefined && manifest.build?.runAttempt !== String(runAttempt))
        || manifest.build?.runId !== String(runId)) throw new Error('Release identity does not match the expected successful build');
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 16) throw new Error('Invalid release artifact list');
    const names = new Set();
    for (const item of manifest.artifacts) {
        if (!item || names.has(item.name)) throw new Error('Invalid or duplicate artifact');
        names.add(item.name);
        const path = artifactPath(directory, item.name);
        if (statSync(path).size !== item.bytes || await digestFile(path) !== item.sha256) throw new Error(`Artifact digest mismatch: ${item.name}`);
        if (item.name.endsWith('.tgz')) {
            const pkg = packedMetadata(path);
            if (pkg.version !== version || pkg.muxrRelease?.commit !== commit || pkg.muxrRelease?.sourceTree !== manifest.source.tree
                || pkg.muxrRelease?.sourceDirty !== false || pkg.muxrRelease?.channel !== expected.channel) throw new Error('npm package identity does not match the release');
        }
    }
    return manifest;
}
