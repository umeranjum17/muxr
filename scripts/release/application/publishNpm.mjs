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
        // Metadata reads are small and must fail fast; publishing uploads the
        // whole tarball and keeps the longer budget.
        const timeout = args[0] === 'publish' ? 180000 : 20000;
        const result = spawnSync('npm', args, { encoding: 'utf8', timeout });
        if (result.status === 0) return result.stdout.trim();
        if (allowMissing && /E404/.test(result.stderr)) return undefined;
        const detail = (result.stderr || result.error?.message || 'no output').trim().slice(-400);
        throw new Error(`npm ${args.join(' ')} failed (${result.status ?? 'no exit status'}): ${detail}`);
    }
    // The registry is read-after-write eventually consistent: a view issued
    // within a second of publish can miss on a replica, answer empty, or still
    // serve the previous dist-tag. Retry until the exact expected value shows.
    // `retryMismatch` separates "not caught up yet" from "wrong bytes": a tag
    // catches up, a differing integrity never does and must fail at once.
    async function confirm(args, expected, { retryMismatch = false } = {}) {
        let seen;
        for (let attempt = 0; attempt < 10; attempt += 1) {
            if (attempt > 0) await new Promise((done) => setTimeout(done, 3000));
            const value = npm(args, true);
            if (value === undefined || value === '') continue;
            seen = JSON.parse(value);
            if (seen === expected || !retryMismatch) return seen;
        }
        const detail = seen === undefined ? 'never became visible' : `still reports ${JSON.stringify(seen)}, expected ${JSON.stringify(expected)}`;
        throw new Error(`${spec} was published but ${args.slice(1).join(' ')} ${detail} on the registry; re-run this job to confirm it`);
    }
    const spec = `@trymuxr/cli@${RELEASE_VERSION}`;
    const existing = npm(['view', spec, 'dist.integrity', '--json'], true);
    if (existing !== undefined && JSON.parse(existing) !== integrity) throw new Error('An existing npm version has different bytes');
    const tags = JSON.parse(npm(['view', '@trymuxr/cli', 'dist-tags', '--json']));
    const current = tags[manifest.release.distTag];
    if (current && compareVersions(current, RELEASE_VERSION) === undefined) throw new Error('Invalid registry channel version');
    if (current && compareVersions(current, RELEASE_VERSION) > 0) throw new Error('Refusing to move the channel backwards');
    if (existing === undefined) npm(['publish', path, '--tag', manifest.release.distTag, '--access', 'public', '--provenance']);
    else if (current !== RELEASE_VERSION) npm(['dist-tag', 'add', spec, manifest.release.distTag]);
    // Different bytes under the same version is never a propagation delay.
    if (await confirm(['view', spec, 'dist.integrity', '--json'], integrity) !== integrity) throw new Error('Published npm integrity mismatch');
    await confirm(['view', '@trymuxr/cli', `dist-tags.${manifest.release.distTag}`, '--json'], RELEASE_VERSION, { retryMismatch: true });
    process.stdout.write(`Verified ${spec} on ${manifest.release.distTag}; published bytes match the candidate.\n`);
}
