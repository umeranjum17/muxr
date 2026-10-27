import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { distribution, compareVersions } from '../domain/channel.mjs';
import { artifactPath, digestFile, readReleaseManifest } from '../infrastructure/artifacts.mjs';
import { verifyRelease } from './verifyRelease.mjs';

export function nightlyVersion(tag, requestedVersion = '') {
    const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
    distribution(version, 'nightly');
    if (requestedVersion && requestedVersion !== version) throw new Error('Requested version does not match the nightly tag');
    return version;
}

/** Read only: bind both seals and the npm bytes to the tag, then plan publication. */
export async function resolveNightly({ directory, tag, requestedVersion, commit, registry }) {
    const version = nightlyVersion(tag, requestedVersion);
    const combined = readReleaseManifest(directory);
    if (!/^[1-9]\d{0,19}$/.test(combined.build?.runId ?? '')) throw new Error('Invalid candidate build run identity');
    const npmPath = artifactPath(directory, 'npm-manifest.json');
    const records = combined.artifacts?.filter((item) => item.name === 'npm-manifest.json');
    const record = records?.[0];
    if (records?.length !== 1 || statSync(npmPath).size !== record.bytes || await digestFile(npmPath) !== record.sha256) throw new Error('npm manifest does not match the candidate seal');
    const manifest = await verifyRelease({ directory, commit, version, channel: 'nightly', runId: combined.build?.runId,
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
    if (registry.integrity !== undefined && registry.integrity !== integrity) throw new Error('An existing npm version has different bytes');
    const needed = registry.integrity === undefined;
    if (needed) {
        const stable = registry.tags.latest;
        distribution(stable, 'stable');
        if (compareVersions(version, stable) <= 0) throw new Error(`${version} does not sort above the published stable ${stable}`);
        const current = registry.tags.nightly;
        if (current && (compareVersions(current, version) === undefined || compareVersions(current, version) > 0)) throw new Error('Refusing to move the nightly channel backwards');
    }
    return { needed, version, channel: 'nightly', distTag: 'nightly', tarball, integrity, commit, runId: manifest.build.runId, manifest };
}
