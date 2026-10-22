import { execFileSync } from 'node:child_process';
import { CANONICAL_REPOSITORY } from '../domain/channelCatalog.mjs';
import { releaseBuild } from '../domain/releaseJourney.mjs';
import { readReleaseManifestAsset, readTagCommit, requireRegistryTarball } from '../infrastructure/catalogBranch.mjs';
import { readRegistryDistTag } from '../infrastructure/publicRecord.mjs';
import { checkJourneyReceipt } from './checkJourneyReceipt.mjs';

const PACKAGE = '@trymuxr/cli';

/**
 * The only way npm `latest` moves. A stable version becomes `latest` when the
 * release journey passed on its exact build: the APK and npm tarball its
 * GitHub release sealed, which must also be the bytes npm serves. The check
 * runs first and the dist-tag moves only after it passes; `checkOnly` stops
 * before the move.
 */
export async function promoteLatest({ repository = CANONICAL_REPOSITORY, version, repo = process.cwd(), receiptsRef = 'origin/main', checkOnly = false }) {
    const tag = `v${version}`;
    if (!/^v[0-9A-Za-z.-]{1,120}$/.test(tag)) throw new Error('An exact release version is required, such as 0.2.10');
    const manifest = readReleaseManifestAsset({ repository, tag });
    if (manifest.release?.channel !== 'stable') throw new Error(`${tag} is a ${manifest.release?.channel} release; only stable becomes npm latest`);
    const taggedCommit = readTagCommit({ repository, tag });
    if (manifest.source?.commit !== taggedCommit) throw new Error(`${tag} points at ${taggedCommit}, but its manifest was sealed from ${manifest.source?.commit}`);
    const build = releaseBuild(manifest);
    if (build.version !== version) throw new Error(`${tag} carries ${build.version}, not ${version}`);
    const tarball = manifest.artifacts.find((item) => item.name.endsWith('.tgz'));
    if (tarball === undefined) throw new Error(`${tag} has no npm tarball in its manifest`);
    await requireRegistryTarball({ repository, tag, tarball, package: PACKAGE, version });

    const proof = checkJourneyReceipt({ repo, commit: taggedCommit, receiptsRef, build });
    if (!proof.ok) throw new Error(`${version} has no passing release journey on its exact build:\n${proof.reason}`);
    if (checkOnly) return { version, moved: false, proof: proof.path };
    if (await readRegistryDistTag({ package: PACKAGE, tag: 'latest' }) === version) return { version, moved: false, proof: proof.path };
    execFileSync('npm', ['dist-tag', 'add', `${PACKAGE}@${version}`, 'latest'], { stdio: 'inherit' });
    return { version, moved: true, proof: proof.path };
}
