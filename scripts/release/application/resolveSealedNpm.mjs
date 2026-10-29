import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { artifactPath, digestFile, readReleaseManifest } from '../infrastructure/artifacts.mjs';
import { verifyRelease } from './verifyRelease.mjs';

/** Both channels bind the npm seal and every npm artifact to the tagged source. */
export async function resolveSealedNpm({ directory, commit, version, channel }) {
    const combined = readReleaseManifest(directory);
    if (!/^[1-9]\d{0,19}$/.test(combined.build?.runId ?? '')) throw new Error('Invalid candidate build run identity');
    const npmPath = artifactPath(directory, 'npm-manifest.json');
    const records = combined.artifacts?.filter((item) => item.name === 'npm-manifest.json');
    const record = records?.[0];
    if (records?.length !== 1 || statSync(npmPath).size !== record.bytes || await digestFile(npmPath) !== record.sha256) throw new Error('npm manifest does not match the candidate seal');
    const manifest = await verifyRelease({ directory, commit, version, channel, runId: combined.build?.runId,
        runAttempt: combined.build?.runAttempt, manifestName: 'npm-manifest.json' });
    for (const key of ['schema', 'release', 'source', 'build']) {
        if (JSON.stringify(combined[key]) !== JSON.stringify(manifest[key])) throw new Error(`Candidate and npm manifest disagree: ${key}`);
    }
    for (const item of manifest.artifacts) {
        const records = combined.artifacts.filter((entry) => entry.name === item.name);
        if (records.length !== 1 || records[0].bytes !== item.bytes || records[0].sha256 !== item.sha256) throw new Error(`Candidate and npm manifest disagree: ${item.name}`);
    }
    const packages = manifest.artifacts.filter((item) => item.name.endsWith('.tgz'));
    if (packages.length !== 1) throw new Error('Exactly one sealed npm tarball is required');
    const tarball = packages[0].name;
    const integrity = `sha512-${createHash('sha512').update(readFileSync(artifactPath(directory, tarball))).digest('base64')}`;

    return { manifest, tarball, integrity };
}
