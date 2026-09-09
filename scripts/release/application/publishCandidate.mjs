import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { verifyRelease } from './verifyRelease.mjs';
import { sealRelease } from './sealRelease.mjs';
import { reportFiles } from './prepareChangelog.mjs';
import { digestFile } from '../infrastructure/artifacts.mjs';

export async function publishCandidate() {
    const { RUNNER_TEMP, VERSION, CHANNEL, GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY, BUILD_CODE } = process.env;
    const directory = join(RUNNER_TEMP, 'candidate');
    await verifyRelease({ directory, version: VERSION, channel: CHANNEL, commit: GITHUB_SHA, runId: GITHUB_RUN_ID });
    const androidDirectory = join(RUNNER_TEMP, 'android');
    const android = JSON.parse(readFileSync(join(androidDirectory, 'result.json')));
    // Nightly carries the development application identity so it installs
    // beside the production app; stable is the production identity.
    const expectedId = CHANNEL === 'nightly' ? 'app.muxr.local.dev' : 'com.trymuxr.app';
    if (android.gitCommitHash !== GITHUB_SHA || android.bundleIdentifier !== expectedId || android.appBuildVersion !== BUILD_CODE) throw new Error('Android source or identity mismatch');
    const apk = readdirSync(androidDirectory).filter((name) => name.endsWith('.apk'));
    const aab = readdirSync(androidDirectory).filter((name) => name.endsWith('.aab'));
    if (apk.length !== 1 || aab.length !== 1 || await digestFile(join(androidDirectory, apk[0])) !== android.apkArtifactSha256
        || await digestFile(join(androidDirectory, aab[0])) !== android.artifactSha256) throw new Error('Android artifact mismatch');
    const signer = readFileSync(join(androidDirectory, 'signer.txt'), 'utf8').match(/certificate SHA-256 digest: ([a-f0-9]{64})/i)?.[1].toLowerCase();
    if (!signer) throw new Error('Missing verified Android signer');
    renameSync(join(directory, 'release-manifest.json'), join(directory, 'npm-manifest.json'));
    // The Android artifact carries its own report, rendered from the same source
    // with the build code in it. The candidate's report is already verified
    // against the manifest it was sealed under, so it is never replaced here.
    const reports = new Set(Object.values(reportFiles));
    for (const file of readdirSync(androidDirectory)) {
        if (reports.has(file)) continue;
        copyFileSync(join(androidDirectory, file), join(directory, file));
    }
    await sealRelease({ directory, version: VERSION, channel: CHANNEL, files: readdirSync(directory), runId: GITHUB_RUN_ID, runAttempt: GITHUB_RUN_ATTEMPT,
        android: { applicationId: expectedId, versionCode: Number(BUILD_CODE), signerSha256: signer } });
    // Notes were rendered and sealed from the candidate's own source. This
    // checkout is newer, so it publishes those retained bytes unchanged.
    const notes = join(directory, reportFiles.markdown);
    if (!existsSync(notes)) throw new Error('Candidate carries no release notes');
    execFileSync('gh', ['release', 'create', `v${VERSION}`, ...readdirSync(directory).map((name) => join(directory, name)), '--repo', GITHUB_REPOSITORY,
        '--target', GITHUB_SHA, '--title', `muxr ${VERSION}`, '--prerelease', '--latest=false', '--notes-file', notes], { stdio: 'inherit' });
}
