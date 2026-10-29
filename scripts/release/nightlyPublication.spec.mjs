import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { sealRelease } from './application/sealRelease.mjs';
import { resolveNightly } from './application/resolveNightly.mjs';

it('admits a sealed stable from main or its exact tag, never another branch or tag', () => {
    const cli = fileURLToPath(new URL('./presentation/stableDecision.mjs', import.meta.url));
    const version = '0.2.18';
    for (const ref of ['refs/heads/main', `refs/tags/v${version}`, 'refs/heads/release', 'refs/heads/v0.2.18', 'refs/tags/v0.2.17', 'refs/tags/v0.2.18-extra', '']) {
        const result = spawnSync(process.execPath, [cli, '--version', version, '--requested-version', version, '--owner-authorized'], {
            encoding: 'utf8', env: { ...process.env, GITHUB_REF: ref },
        });
        expect(result.status).toBe(1);
        // Admitted refs reach the next real boundary, before any download or npm request.
        const admitted = ref === 'refs/heads/main' || ref === `refs/tags/v${version}`;
        expect(result.stderr).toContain(admitted ? '--directory is required' : 'Dispatch sealed_release from main or its matching release tag');
    }
});

it('resolves the sealed nightly bytes, refuses conflicting identities, and retries a published version without moving tags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'muxr-nightly-'));
    try {
        const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
        git('init', '-q');
        git('config', 'user.name', 'Release flow');
        git('config', 'user.email', 'release@example.test');
        writeFileSync(join(root, 'source'), 'nightly source\n');
        git('add', 'source');
        git('commit', '-qm', 'source');
        const commit = git('rev-parse', 'HEAD');
        const tree = git('rev-parse', 'HEAD^{tree}');
        const version = '0.2.16-nightly.41.1';
        const tag = `v${version}`;
        git('tag', tag);
        const directory = join(root, 'assets');
        mkdirSync(join(directory, 'package'), { recursive: true });
        writeFileSync(join(directory, 'package', 'package.json'), JSON.stringify({ name: '@trymuxr/cli', version,
            muxrRelease: { commit, sourceTree: tree, sourceDirty: false, channel: 'nightly' } }));
        const tarball = `trymuxr-cli-${version}.tgz`;
        execFileSync('tar', ['-czf', join(directory, tarball), '-C', directory, 'package']);
        const seal = { directory, version, channel: 'nightly', runId: '41', sourceRoot: root };
        // Assets are outside the tracked source, exactly as on the runner.
        writeFileSync(join(root, '.git', 'info', 'exclude'), 'assets/\n');
        await sealRelease({ ...seal, files: [tarball] });
        const manifest = readFileSync(join(directory, 'release-manifest.json'));
        writeFileSync(join(directory, 'npm-manifest.json'), manifest);
        rmSync(join(directory, 'release-manifest.json'));
        await sealRelease({ ...seal, files: [tarball, 'npm-manifest.json'] });
        const command = { directory, tag, commit, registry: { tags: { latest: '0.2.15', nightly: '0.1.29-nightly.13.1' } } };
        const plan = await resolveNightly(command);
        expect(plan).toMatchObject({ needed: true, version, tarball, distTag: 'nightly', runId: '41' });
        const registry = join(directory, 'registry.json');
        writeFileSync(registry, JSON.stringify(command.registry));
        const cli = fileURLToPath(new URL('./presentation/nightlyDecision.mjs', import.meta.url));
        const output = execFileSync(process.execPath, [cli, '--tag', tag, '--directory', directory, '--registry-state', registry], { cwd: root, encoding: 'utf8' });
        expect(output).toContain(`Would publish ${tarball} under npm nightly with provenance.`);
        await expect(resolveNightly({ ...command, tag: 'v0.2.16' })).rejects.toThrow('requested release channel');
        await expect(resolveNightly({ ...command, requestedVersion: '0.2.16' })).rejects.toThrow('does not match');
        await expect(resolveNightly({ ...command, tag: 'v0.2.16-nightly.42.1' })).rejects.toThrow('Release identity');
        await expect(resolveNightly({ ...command, commit: 'f'.repeat(40) })).rejects.toThrow('Release identity');
        await expect(resolveNightly({ ...command, registry: { tags: { latest: '0.2.16' } } })).rejects.toThrow('does not sort above');
        expect(await resolveNightly({ ...command, registry: { integrity: plan.integrity,
            tags: { latest: '0.2.17', nightly: '0.2.18-nightly.1' } } })).toMatchObject({ needed: false });
        await expect(resolveNightly({ ...command, registry: { integrity: 'sha512-wrong', tags: {} } })).rejects.toThrow('different bytes');
        writeFileSync(join(directory, tarball), 'changed bytes');
        await expect(resolveNightly(command)).rejects.toThrow('Artifact digest mismatch');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
