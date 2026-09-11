import { CANONICAL_REPOSITORY, channelEntry } from '../domain/channelCatalog.mjs';
import { markReleaseLatest, readLatestReleaseTag, readReleaseManifestAsset, readReleaseMetadata } from '../infrastructure/catalogBranch.mjs';
import { readRegistryDistTag } from '../infrastructure/publicRecord.mjs';

const PACKAGE = '@trymuxr/cli';

/**
 * Stable promotion clears the prerelease flag on the release that already
 * exists and makes it GitHub's Latest, so `releases/latest/download` follows
 * the accepted stable. No new release, no new binary, no retagging; beta and
 * dev keep their prerelease status and never become Latest.
 */
export async function promoteReleaseVisibility({ repository = CANONICAL_REPOSITORY, tag } = {}) {
    if (!/^v[0-9A-Za-z.-]{1,120}$/.test(tag ?? '')) throw new Error('An exact release tag is required to promote visibility');
    const release = readReleaseMetadata({ repository, tag });
    const manifest = readReleaseManifestAsset({ repository, tag });
    const { channel, entry } = channelEntry({ repository, tag, manifest, publishedAt: release.publishedAt });
    if (channel !== 'stable') throw new Error(`${tag} is a ${channel} release; only stable becomes GitHub's Latest`);
    const registryVersion = await readRegistryDistTag({ package: PACKAGE, tag: entry.npmDistTag });
    if (registryVersion !== entry.version) {
        throw new Error(`npm latest is ${registryVersion}, not ${entry.version}; promote the package before promoting its release`);
    }
    const name = `muxr ${entry.version}`;
    // Being non-prerelease is not the same as being Latest: another release can
    // hold that pointer, and a rerun has to be able to repair exactly that.
    const alreadyLatest = release.prerelease === false && release.name === name && readLatestReleaseTag({ repository }) === tag;
    if (alreadyLatest) return { tag, changed: false, name };
    markReleaseLatest({ repository, id: release.id, name });
    return { tag, changed: true, name };
}
