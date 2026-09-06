import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
    CANONICAL_REPOSITORY, CATALOG_BRANCH, MANIFEST_ASSET, channelEntry, mergeCatalog, parseCatalog, serializeCatalog,
} from '../domain/channelCatalog.mjs';
import {
    commitCatalogBranch, readCatalogBranch, readReleaseManifestAsset, readReleaseMetadata, readTagCommit, withReleaseAsset,
} from '../infrastructure/catalogBranch.mjs';
import { readRegistryDistTag, readRegistryIntegrity } from '../infrastructure/publicRecord.mjs';

const PACKAGE = '@trymuxr/cli';

/**
 * Points one public channel at an already published, already verified release.
 * Every field is derived from that release's own combined manifest, and every
 * artifact it names is re-checked against the bytes GitHub and npm actually
 * hold. No rebuild, no retagging, nothing copied.
 */
export async function updateChannelCatalog({ repository = CANONICAL_REPOSITORY, tag, branch = CATALOG_BRANCH, verifyCatalog = true } = {}) {
    if (repository !== CANONICAL_REPOSITORY) throw new Error('The public catalog belongs to the canonical repository');
    if (!/^v[0-9A-Za-z.-]{1,120}$/.test(tag ?? '')) throw new Error('An exact release tag is required, such as v0.1.28-nightly.1.1');
    const release = readReleaseMetadata({ repository, tag });
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    if (!assets.has(MANIFEST_ASSET)) throw new Error(`${tag} has no retained ${MANIFEST_ASSET} to derive from`);

    // The combined GitHub release manifest, never the npm-only candidate one:
    // only it carries the Android artifact digest and build identity.
    const manifest = readReleaseManifestAsset({ repository, tag });
    const taggedCommit = readTagCommit({ repository, tag });
    if (manifest.source?.commit !== taggedCommit) {
        throw new Error(`${tag} points at ${taggedCommit}, but its manifest was sealed from ${manifest.source?.commit}`);
    }
    const { channel, entry } = channelEntry({ repository, tag, manifest, publishedAt: release.publishedAt });

    // The APK the catalog advertises must be the artifact GitHub is serving.
    const apkName = entry.android.url.split('/').pop();
    const apk = assets.get(apkName);
    if (apk === undefined) throw new Error(`${tag} does not carry the APK its manifest names (${apkName})`);
    if (apk.size !== entry.android.bytes) throw new Error(`${apkName} is ${apk.size} bytes on the release, ${entry.android.bytes} in its manifest`);
    if (apk.digest !== `sha256:${entry.android.sha256}`) {
        throw new Error(`${apkName} reports digest ${apk.digest ?? 'none'}, expected sha256:${entry.android.sha256}; re-upload or verify the release asset`);
    }

    // The published package must be the retained tarball, byte for byte.
    const tarball = manifest.artifacts.find((item) => item.name.endsWith('.tgz'));
    if (tarball === undefined) throw new Error(`${tag} has no npm tarball in its manifest`);
    const registryIntegrity = await readRegistryIntegrity({ package: PACKAGE, version: entry.version });
    await withReleaseAsset({ repository, tag, name: tarball.name }, async (asset) => {
        if (asset.bytes !== tarball.bytes || asset.sha256 !== tarball.sha256) {
            throw new Error(`${tarball.name} on the release does not match its manifest digest`);
        }
        const integrity = `sha512-${createHash('sha512').update(readFileSync(asset.path)).digest('base64')}`;
        if (integrity !== registryIntegrity) throw new Error(`npm ${entry.version} was published from different bytes than ${tarball.name}`);
    });

    // The registry decides what a channel currently is; the catalog mirrors it.
    const registryVersion = await readRegistryDistTag({ package: PACKAGE, tag: entry.npmDistTag });
    if (registryVersion !== entry.version) {
        throw new Error(`npm ${entry.npmDistTag} is ${registryVersion}, not ${entry.version}; publish the package before pointing the public channel at it`);
    }

    let published;
    for (let attempt = 0; attempt < 8 && published === undefined; attempt += 1) {
        const { parent, text } = readCatalogBranch({ repository, branch });
        const next = serializeCatalog(mergeCatalog(parseCatalog(text), channel, entry));
        if (text === next) { published = { channel, entry, changed: false }; break; }
        if (commitCatalogBranch({ repository, branch, parent, text: next, message: `Point ${channel} at ${entry.version}` })) {
            published = { channel, entry, changed: true };
        }
    }
    if (published === undefined) throw new Error('The catalog branch kept advancing; no update was recorded');
    if (verifyCatalog) {
        // Read the branch back through the API, which is authoritative and not
        // CDN-cached. Waiting out the raw CDN here as well would double a
        // multi-minute convergence the final public gate already covers.
        const recorded = parseCatalog(readCatalogBranch({ repository, branch }).text).channels[channel];
        if (JSON.stringify(recorded) !== JSON.stringify(entry)) {
            throw new Error(`the catalog branch holds a different ${channel} record after writing ${entry.version}`);
        }
    }
    return published;
}
