import { checkJourneyReceipt } from '../application/checkJourneyReceipt.mjs';
import { CANONICAL_REPOSITORY } from '../domain/channelCatalog.mjs';
import { releaseBuild, RELEASE_JOURNEY } from '../domain/releaseJourney.mjs';
import { readReleaseManifestAsset } from '../infrastructure/catalogBranch.mjs';

const option = (key) => {
    const index = process.argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    return process.argv[index + 1];
};
const journey = option('journey') ?? RELEASE_JOURNEY;
const commit = option('commit') ?? process.env.RELEASE_COMMIT ?? 'HEAD';
const receiptsRef = option('receipts') ?? process.env.RELEASE_RECEIPTS_REF ?? 'origin/main';
const tag = option('tag') ?? process.env.GITHUB_RELEASE_TAG;
if (!tag) throw new Error('usage: checkJourneyReceipt.mjs --tag v<version> [--commit <ref>] [--receipts <ref>]: the tag names the exact build to check');
// The build is the one the GitHub release sealed: its APK and npm tarball digests.
const build = releaseBuild(readReleaseManifestAsset({ repository: CANONICAL_REPOSITORY, tag }));
const result = checkJourneyReceipt({ commit, receiptsRef, journey, build });
if (result.ok) {
    process.stdout.write(`the ${journey} receipt ${result.path} proves ${result.receipt.head.slice(0, 12)} and build ${build.version}\n`);
    if (result.timings) process.stdout.write(`its x86_64 twin's times (${JSON.stringify(result.timings)}) do not gate: the owner's phone test does\n`);
} else {
    process.stderr.write(`the release has no ${journey} proof on build ${build.version}:\n${result.reason}\n`);
    process.exitCode = 1;
}
