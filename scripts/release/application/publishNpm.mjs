import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { verifyRelease } from './verifyRelease.mjs';
import { channelTags, compareVersions, releaseVersion } from '../domain/channel.mjs';
import { desktopHostOfTarball, requireDesktopEngine } from './requireDesktopEngine.mjs';
import { requireLinkProtocol } from './requireLinkProtocol.mjs';
import { resolveNightly } from './resolveNightly.mjs';
import { resolveStable } from './resolveStable.mjs';

const spec = (version) => `@trymuxr/cli@${version}`;

const output = (result) => [result.stdout, result.stderr].map((text) => (text ?? '').trim()).filter(Boolean).join('\n');

/** npm's own words for a failed command, verbatim, with the HTTP status and error code lines intact. */
function npmFailure(args, result) {
    const detail = output(result) || result.error?.message || 'no output';
    return `npm ${args.join(' ')} failed (${result.status ?? 'no exit status'}):\n${detail}`;
}

/** A 409 from publish that says this version is already staged, awaiting a maintainer's approval. */
const stagedConflict = (text, version) => /409/.test(text) && text.includes(`Cannot publish over previously staged version ${version}`);

function npm(args, allowMissing = false, run = spawnSync) {
    // Metadata reads are small and must fail fast; publishing uploads the
    // whole tarball and keeps the longer budget.
    const timeout = args[0] === 'publish' ? 180000 : 20000;
    const result = run('npm', args, { encoding: 'utf8', timeout });
    if (result.status === 0) return result.stdout.trim();
    if (allowMissing && /E404/.test(result.stderr)) return undefined;
    throw new Error(npmFailure(args, result));
}

/**
 * Publish the tarball. A staged-version conflict is a recognised outcome, not
 * an unsettled publish: it is never retried, and the error names the maintainer's
 * next step. Anything else is npm's own output, verbatim.
 */
export function publishTarball(path, tag, version, run = spawnSync) {
    const args = ['publish', path, '--tag', tag, '--access', 'public', '--provenance'];
    const result = run('npm', args, { encoding: 'utf8', timeout: 180000 });
    if (result.status === 0) return;
    const text = output(result);
    // The job log carries npm's lines even when a caller swallows the error.
    process.stderr.write(`${text || result.error?.message || 'npm printed nothing'}\n`);
    if (!stagedConflict(text, version)) throw new Error(npmFailure(args, result));
    let live = 'unknown (npm view failed)';
    try {
        live = npm(['view', '@trymuxr/cli', `dist-tags.${tag}`, '--json'], false, run);
    } catch (error) {
        live = `unknown (${error.message.split('\n')[0]})`;
    }
    throw new Error([
        `${spec(version)} is already staged on npm; it was not published again and nothing was retried.`,
        `npm said:\n${text}`,
        `Live dist-tag ${tag} is ${live}, so ${version} is not live yet.`,
        'A maintainer promotes it with their 2FA code:',
        '  npm stage list',
        `  npm stage approve <stage-id>   (the stage id of ${spec(version)} from the list)`,
    ].join('\n'));
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
    // Stable versions published before stable went straight to `latest` sit
    // under `next`, and no tag can move them now: only their bytes are confirmed.
    const { channel } = releaseVersion(version);
    if (channel !== 'stable') await tagAtLeast(version, channelTags[channel]);
}

export function npmPublicationState(version) {
    const value = npm(['view', spec(version), 'dist.integrity', '--json'], true);
    const tags = JSON.parse(npm(['view', '@trymuxr/cli', 'dist-tags', '--json']));
    let integrity = value === undefined ? undefined : JSON.parse(value);
    if (Array.isArray(integrity)) [integrity] = integrity;
    return { integrity, tags: Array.isArray(tags) ? tags[0] : tags };
}

export async function publishNpm() {
    const { RUNNER_TEMP, RELEASE_COMMIT, RELEASE_VERSION, RELEASE_CHANNEL, BUILD_RUN_ID, NIGHTLY_TAG, SEALED_RELEASE } = process.env;
    const directory = join(RUNNER_TEMP, 'package');
    let manifest;
    if (SEALED_RELEASE) {
        if (NIGHTLY_TAG || RELEASE_CHANNEL !== 'stable' || SEALED_RELEASE !== RELEASE_VERSION) throw new Error('Sealed stable publication identity mismatch');
        const taggedCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/v${SEALED_RELEASE}^{commit}`], { encoding: 'utf8' }).trim();
        if (taggedCommit !== RELEASE_COMMIT) throw new Error('Stable tag no longer matches the resolved candidate commit');
        const plan = await resolveStable({ directory, version: RELEASE_VERSION, commit: RELEASE_COMMIT, registry: npmPublicationState(RELEASE_VERSION) });
        manifest = plan.manifest;
    } else if (NIGHTLY_TAG) {
        if (RELEASE_CHANNEL !== 'nightly') throw new Error('A nightly tag can only publish to nightly');
        const taggedCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${NIGHTLY_TAG}^{commit}`], { encoding: 'utf8' }).trim();
        if (taggedCommit !== RELEASE_COMMIT) throw new Error('Nightly tag no longer matches the resolved candidate commit');
        const plan = await resolveNightly({ directory, tag: NIGHTLY_TAG, requestedVersion: RELEASE_VERSION, commit: RELEASE_COMMIT, registry: npmPublicationState(RELEASE_VERSION) });
        if (!plan.needed) {
            process.stdout.write(`${spec(RELEASE_VERSION)} already published with identical bytes; no tags moved.\n`);
            return;
        }
        manifest = plan.manifest;
    } else {
        manifest = await verifyRelease({ directory, commit: RELEASE_COMMIT, version: RELEASE_VERSION, channel: RELEASE_CHANNEL, runId: BUILD_RUN_ID });
    }
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
    const publishTag = channelTags[manifest.release.channel];
    const tags = JSON.parse(npm(['view', '@trymuxr/cli', 'dist-tags', '--json']));
    const current = tags[publishTag];
    if (current && compareVersions(current, RELEASE_VERSION) === undefined) throw new Error('Invalid registry channel version');
    if (current && compareVersions(current, RELEASE_VERSION) > 0) throw new Error('Refusing to move the channel backwards');
    // Trusted publishing can publish a version but not move a tag: the tag is
    // set by this publication or not at all.
    if (existing === undefined) publishTarball(path, publishTag, RELEASE_VERSION);
    else if (current !== RELEASE_VERSION) throw new Error(`${spec(RELEASE_VERSION)} is already on npm without the ${publishTag} tag, and trusted publishing cannot move a tag; publish a new version`);
    // Different bytes under the same version is never a propagation delay.
    if (await integrityOf(RELEASE_VERSION) !== integrity) throw new Error('Published npm integrity mismatch');
    await tagAtLeast(RELEASE_VERSION, publishTag);
    process.stdout.write(`Verified ${spec(RELEASE_VERSION)} on ${publishTag}; published bytes match the candidate.\n`);
}
