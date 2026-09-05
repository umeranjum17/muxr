import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyRelease } from './verifyRelease.mjs';
import { compareVersions } from '../domain/channel.mjs';

export async function publishNpm() {
    const { RUNNER_TEMP, RELEASE_COMMIT, RELEASE_VERSION, RELEASE_CHANNEL, BUILD_RUN_ID } = process.env;
    const directory = join(RUNNER_TEMP, 'package');
    const manifest = await verifyRelease({ directory, commit: RELEASE_COMMIT, version: RELEASE_VERSION, channel: RELEASE_CHANNEL, runId: BUILD_RUN_ID });
    const packages = manifest.artifacts.filter((item) => item.name.endsWith('.tgz'));
    if (packages.length !== 1) throw new Error('Exactly one tested npm tarball is required');
    const path = join(directory, packages[0].name);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
    function npm(args, allowMissing = false) {
        const result = spawnSync('npm', args, { encoding: 'utf8', timeout: 180000 });
        if (result.status === 0) return result.stdout.trim();
        if (allowMissing && /E404/.test(result.stderr)) return undefined;
        throw new Error(`npm operation failed: ${args[0]}`);
    }
    const spec = `@trymuxr/cli@${RELEASE_VERSION}`;
    const existing = npm(['view', spec, 'dist.integrity', '--json'], true);
    if (existing !== undefined && JSON.parse(existing) !== integrity) throw new Error('An existing npm version has different bytes');
    const tags = JSON.parse(npm(['view', '@trymuxr/cli', 'dist-tags', '--json']));
    const current = tags[manifest.release.distTag];
    if (current && compareVersions(current, RELEASE_VERSION) > 0) throw new Error('Refusing to move the channel backwards');
    if (existing === undefined) npm(['publish', path, '--tag', manifest.release.distTag, '--access', 'public', '--provenance']);
    else if (current !== RELEASE_VERSION) npm(['dist-tag', 'add', spec, manifest.release.distTag]);
    if (JSON.parse(npm(['view', spec, 'dist.integrity', '--json'])) !== integrity) throw new Error('Published npm integrity mismatch');
    if (JSON.parse(npm(['view', '@trymuxr/cli', `dist-tags.${manifest.release.distTag}`, '--json'])) !== RELEASE_VERSION) throw new Error('Published channel mismatch');
    process.stdout.write(`Verified ${spec} on ${manifest.release.distTag}; published bytes match the candidate.\n`);
}
