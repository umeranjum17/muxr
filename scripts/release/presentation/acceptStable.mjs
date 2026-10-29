import { appendFileSync, writeFileSync } from 'node:fs';
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
if (!version || !tarball) throw new Error('usage: acceptStable.mjs --version <stable version> --package <tarball to publish> [--captain-tested <version>] [--owner-authorized <version>] [--receipts <ref>]');
const tag = `v${version}`;
if (!/^v[0-9A-Za-z.-]{1,120}$/.test(tag)) throw new Error('An exact release version is required, such as 0.2.11');
const result = acceptStable({
    version,
    manifest: readReleaseManifestAsset({ repository: CANONICAL_REPOSITORY, tag }),
    taggedCommit: readTagCommit({ repository: CANONICAL_REPOSITORY, tag }),
    tarballSha256: await digestFile(tarball),
    // Empty on a push: only a run the captain starts by hand names a version.
    captainTested: option('captain-tested') || undefined,
    // Empty unless the run opted into the owner-authorized path, which is never a captain test.
    ownerAuthorized: option('owner-authorized') || undefined,
    receiptsRef: option('receipts') ?? 'origin/main',
});
const message = result.ok
    ? `${version} may be published as npm latest; its release journey receipt is ${result.proof}${result.authorization ? `\n${result.authorization.notice}` : ''}`
    : `npm latest stays where it is: ${result.reason}`;
process.stdout.write(`${message}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `accepted=${result.ok}\nowner_authorized=${Boolean(result.authorization)}\n`);
if (result.authorization) {
    // The publish log and the GitHub release notes quote this file; nothing renders the build as owner-tested.
    if (process.env.OWNER_AUTHORIZATION_NOTICE_FILE) writeFileSync(process.env.OWNER_AUTHORIZATION_NOTICE_FILE, `${result.authorization.notice}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${version}: owner-authorized, not owner-tested\n\n${result.authorization.notice}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY && !result.ok) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\nOnce the receipt and the journey result for this build are committed to main and the captain's own phone test passed, run release.yml by hand with captain_tested checked and version ${version}. If the captain instead authorized the release before he could test it, commit its owner authorization and run it with owner_authorized checked and the same version, which publishes it labelled owner-authorized and not owner-tested (Use workflow from: main, or ${tag} once main has changed product code since the tag). That run publishes this exact tarball as latest; a push never does.\n`);
}
