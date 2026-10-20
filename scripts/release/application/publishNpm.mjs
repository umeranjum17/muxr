import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyRelease } from './verifyRelease.mjs';
import { compareVersions, publishTags, releaseVersion } from '../domain/channel.mjs';
import { desktopHostOfTarball, requireDesktopEngine } from './requireDesktopEngine.mjs';
import { requireLinkProtocol } from './requireLinkProtocol.mjs';

const spec = (version) => `@trymuxr/cli@${version}`;

function npm(args, allowMissing = false) {
    // Metadata reads are small and must fail fast; publishing uploads the
    // whole tarball and keeps the longer budget.
    const timeout = args[0] === 'publish' ? 180000 : 20000;
    const result = spawnSync('npm', args, { encoding: 'utf8', timeout });
    if (result.status === 0) return result.stdout.trim();
    if (allowMissing && /E404/.test(result.stderr)) return undefined;
    const detail = (result.stderr || result.error?.message || 'no output').trim().slice(-400);
    throw new Error(`npm ${args.join(' ')} failed (${result.status ?? 'no exit status'}): ${detail}`);
}

/** Whether this CLI version is already on npm; a merge that changes nothing publishes nothing. */
export function versionOnNpm(version) {
    const value = npm(['view', spec(version), 'version', '--json'], true);
    return value !== undefined && value !== '';
}

// The registry is read-after-write eventually consistent: a view issued within
// a second of publish can miss on a replica, answer empty, or still serve the
// previous dist-tag. Poll until `ready` accepts the value; the caller decides
// what a value that arrives but differs means.
async function settle(args, ready, what) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (attempt > 0) await new Promise((done) => setTimeout(done, 3000));
        const value = npm(args, true);
        if (value === undefined || value === '') continue;
        const seen = JSON.parse(value);
        if (ready(seen)) return seen;
    }
    throw new Error(`${what} did not settle on the registry; re-run this job to confirm it`);
}

const integrityOf = (version) => settle(['view', spec(version), 'dist.integrity', '--json'], (seen) => typeof seen === 'string', spec(version));
const tagAtLeast = (version, distTag) => settle(['view', '@trymuxr/cli', `dist-tags.${distTag}`, '--json'],
    (seen) => compareVersions(seen, version) >= 0, `${spec(version)} ${distTag} dist-tag`);

/** A version already on npm was published by an earlier run: confirm it, never rebuild or republish it. */
export async function confirmPublished(version) {
    await integrityOf(version);
    await tagAtLeast(version, publishTags[releaseVersion(version).channel]);
}

export async function publishNpm() {
    const { RUNNER_TEMP, RELEASE_COMMIT, RELEASE_VERSION, RELEASE_CHANNEL, BUILD_RUN_ID } = process.env;
    const directory = join(RUNNER_TEMP, 'package');
    const manifest = await verifyRelease({ directory, commit: RELEASE_COMMIT, version: RELEASE_VERSION, channel: RELEASE_CHANNEL, runId: BUILD_RUN_ID });
    const packages = manifest.artifacts.filter((item) => item.name.endsWith('.tgz'));
    if (packages.length !== 1) throw new Error('Exactly one tested npm tarball is required');
    const path = join(directory, packages[0].name);
    requireLinkProtocol(path);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
    // Checked again here, not only when the candidate was built: a registry
    // package can be unpublished in between, and a CLI without it cannot install.
    requireDesktopEngine(desktopHostOfTarball(path));
    const existing = npm(['view', spec(RELEASE_VERSION), 'dist.integrity', '--json'], true);
    if (existing !== undefined && JSON.parse(existing) !== integrity) throw new Error('An existing npm version has different bytes');
    const publishTag = publishTags[manifest.release.channel];
    const tags = JSON.parse(npm(['view', '@trymuxr/cli', 'dist-tags', '--json']));
    const current = tags[publishTag];
    if (current && compareVersions(current, RELEASE_VERSION) === undefined) throw new Error('Invalid registry channel version');
    if (current && compareVersions(current, RELEASE_VERSION) > 0) throw new Error('Refusing to move the channel backwards');
    if (existing === undefined) npm(['publish', path, '--tag', publishTag, '--access', 'public', '--provenance']);
    else if (current !== RELEASE_VERSION) npm(['dist-tag', 'add', spec(RELEASE_VERSION), publishTag]);
    // Different bytes under the same version is never a propagation delay.
    if (await integrityOf(RELEASE_VERSION) !== integrity) throw new Error('Published npm integrity mismatch');
    await tagAtLeast(RELEASE_VERSION, publishTag);
    process.stdout.write(`Verified ${spec(RELEASE_VERSION)} on ${publishTag}; published bytes match the candidate.\n`);
}
