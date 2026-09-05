import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyRelease } from './verifyRelease.mjs';
import { sealRelease } from './sealRelease.mjs';
import { digestFile } from '../infrastructure/artifacts.mjs';

export async function publishCandidate() {
    const { RUNNER_TEMP, VERSION, CHANNEL, GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY, BUILD_CODE } = process.env;
    const directory = join(RUNNER_TEMP, 'candidate');
    await verifyRelease({ directory, version: VERSION, channel: CHANNEL, commit: GITHUB_SHA, runId: GITHUB_RUN_ID });
    const androidDirectory = join(RUNNER_TEMP, 'android');
    const android = JSON.parse(readFileSync(join(androidDirectory, 'result.json')));
    const expectedId = CHANNEL === 'dev' ? 'app.muxr.local.dev' : 'com.trymuxr.app';
    if (android.gitCommitHash !== GITHUB_SHA || android.bundleIdentifier !== expectedId || android.appBuildVersion !== BUILD_CODE) throw new Error('Android source or identity mismatch');
    const apk = readdirSync(androidDirectory).filter((name) => name.endsWith('.apk'));
    const aab = readdirSync(androidDirectory).filter((name) => name.endsWith('.aab'));
    if (apk.length !== 1 || aab.length !== 1 || await digestFile(join(androidDirectory, apk[0])) !== android.apkArtifactSha256
        || await digestFile(join(androidDirectory, aab[0])) !== android.artifactSha256) throw new Error('Android artifact mismatch');
    const signer = readFileSync(join(androidDirectory, 'signer.txt'), 'utf8').match(/certificate SHA-256 digest: ([a-f0-9]{64})/i)?.[1].toLowerCase();
    if (!signer) throw new Error('Missing verified Android signer');
    renameSync(join(directory, 'release-manifest.json'), join(directory, 'npm-manifest.json'));
    for (const file of readdirSync(androidDirectory)) copyFileSync(join(androidDirectory, file), join(directory, file));
    await sealRelease({ directory, version: VERSION, channel: CHANNEL, files: readdirSync(directory), runId: GITHUB_RUN_ID, runAttempt: GITHUB_RUN_ATTEMPT,
        android: { applicationId: expectedId, versionCode: Number(BUILD_CODE), signerSha256: signer } });
    const notes = join(RUNNER_TEMP, 'candidate-notes.md');
    writeFileSync(notes, `Development candidate; **not production**.\n\nChannel: ${CHANNEL}. Source: ${GITHUB_SHA}. Android build: ${BUILD_CODE}.\n\nDownload the APK below. ${CHANNEL === 'dev' ? 'The dev app installs separately and uses manual self-host pairing.' : 'This beta updates the existing direct-install muxr app; it shares its data.'}\n\nThe npm tarball can be installed directly with npm. Registry publication uses the separate verified publisher. Production promotion is manual.\n\n[Build and checks](https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}). Local emulator and phone acceptance are recorded separately; a build is not device acceptance.\n`);
    execFileSync('gh', ['release', 'create', `v${VERSION}`, ...readdirSync(directory).map((name) => join(directory, name)), '--repo', GITHUB_REPOSITORY,
        '--target', GITHUB_SHA, '--title', `muxr ${VERSION} · ${CHANNEL}`, '--prerelease', '--latest=false', '--notes-file', notes], { stdio: 'inherit' });
}
