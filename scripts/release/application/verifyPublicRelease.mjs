import {
    CANONICAL_REPOSITORY, CATALOG_BRANCH, catalogUrl, channelEntry, checksumLineMismatch, publicRecordMismatch,
} from '../domain/channelCatalog.mjs';
import { readLatestReleaseTag, readReleaseManifestAsset, readReleaseMetadata } from '../infrastructure/catalogBranch.mjs';
import { publicDeadline, readPublicJson, readPublicText, readRegistryDistTag, requireRedirect } from '../infrastructure/publicRecord.mjs';

const SITE = 'https://trymuxr.com';
const PACKAGE = '@trymuxr/cli';

/**
 * A release is public when every surface agrees with the release itself: the
 * expectation comes from the exact tag, never from whatever a surface happens
 * to report. Caches are tolerated by retrying, never by relaxing a comparison.
 */
export async function verifyPublicRelease({
    tag, channel, version, repository = CANONICAL_REPOSITORY, branch = CATALOG_BRANCH, site = SITE,
} = {}) {
    if (!/^v[0-9A-Za-z.-]{1,120}$/.test(tag ?? '')) throw new Error('An exact release tag is required to verify a public release');
    const release = readReleaseMetadata({ repository, tag });
    const manifest = readReleaseManifestAsset({ repository, tag });
    const expected = channelEntry({ repository, tag, manifest, publishedAt: release.publishedAt });
    const entry = expected.entry;
    if (channel !== undefined && channel !== expected.channel) throw new Error(`${tag} belongs to ${expected.channel}, not ${channel}`);
    if (version !== undefined && version !== entry.version) throw new Error(`${tag} publishes ${entry.version}, not the expected ${version}`);

    // GitHub visibility is part of the contract: only stable is ever Latest.
    const latestTag = readLatestReleaseTag({ repository });
    const stable = expected.channel === 'stable';
    if (stable && (release.prerelease || latestTag !== tag)) {
        throw new Error(`${tag} is stable but GitHub still reports prerelease=${release.prerelease} and Latest=${latestTag ?? 'none'}`);
    }
    if (!stable && (!release.prerelease || latestTag === tag)) {
        throw new Error(`${tag} is a ${expected.channel} release but GitHub reports prerelease=${release.prerelease} and Latest=${latestTag ?? 'none'}`);
    }

    const registryVersion = await readRegistryDistTag({ package: PACKAGE, tag: entry.npmDistTag });
    if (registryVersion !== entry.version) throw new Error(`npm ${entry.npmDistTag} serves ${registryVersion}, not ${entry.version}`);

    // One budget for every public surface. The raw catalog can sit behind a
    // CDN for minutes; giving each surface its own window would multiply that
    // worst case across the job instead of sharing one wait for convergence.
    const deadline = publicDeadline();
    await readPublicJson(catalogUrl(repository, branch), {
        deadline,
        expect: (value) => {
            const recorded = value?.channels?.[expected.channel];
            if (recorded === undefined) return `catalog has no ${expected.channel} entry`;
            if (JSON.stringify(recorded) !== JSON.stringify(entry)) return `catalog serves ${recorded.version} for ${expected.channel}, expected the ${entry.version} record`;
            return undefined;
        },
    });
    await readPublicJson(`${site}/api/releases/${expected.channel}`, {
        deadline,
        expect: (value) => publicRecordMismatch(entry, value, expected.channel),
    });
    const android = await requireRedirect(`${site}/downloads/${expected.channel}/android`, entry.android.url, { deadline });
    await requireRedirect(`${site}/downloads/${expected.channel}/release`, entry.releaseUrl, { deadline });
    await readPublicText(`${site}/downloads/${expected.channel}/checksums`, {
        deadline,
        expect: (text) => checksumLineMismatch(entry, text),
    });
    return { channel: expected.channel, version: entry.version, apk: entry.android.url, redirectStatus: android.status, latestTag };
}
