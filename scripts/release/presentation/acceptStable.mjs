import { appendFileSync } from 'node:fs';
import { acceptStable } from '../application/acceptStable.mjs';
import { CANONICAL_REPOSITORY } from '../domain/channelCatalog.mjs';
import { digestFile } from '../infrastructure/artifacts.mjs';
import { readReleaseManifestAsset, readTagCommit } from '../infrastructure/catalogBranch.mjs';

// Answers whether a stable version may be published as npm latest. It never
// publishes, so it is also the dry run: point it at the release's own tarball.
const option = (key) => {
    const index = process.argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    return process.argv[index + 1];
};
const version = option('version');
const tarball = option('package');
if (!version || !tarball) throw new Error('usage: acceptStable.mjs --version <stable version> --package <tarball to publish> [--receipts <ref>]');
const tag = `v${version}`;
if (!/^v[0-9A-Za-z.-]{1,120}$/.test(tag)) throw new Error('An exact release version is required, such as 0.2.11');
const result = acceptStable({
    version,
    manifest: readReleaseManifestAsset({ repository: CANONICAL_REPOSITORY, tag }),
    taggedCommit: readTagCommit({ repository: CANONICAL_REPOSITORY, tag }),
    tarballSha256: await digestFile(tarball),
    receiptsRef: option('receipts') ?? 'origin/main',
});
const message = result.ok
    ? `${version} may be published as npm latest; its release journey receipt is ${result.proof}`
    : `npm latest stays where it is: ${result.reason}`;
process.stdout.write(`${message}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `accepted=${result.ok}\n`);
if (process.env.GITHUB_STEP_SUMMARY && !result.ok) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\nCommit the receipt and the journey result for this build to main. That push runs this again; once main has changed product code since ${tag}, run release.yml from the ${tag} tag instead (Run workflow, Use workflow from: ${tag}). Either run publishes this exact tarball as latest.\n`);
}
