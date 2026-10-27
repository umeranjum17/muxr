import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { nightlyVersion, resolveNightly } from '../application/resolveNightly.mjs';
import { npmPublicationState } from '../application/publishNpm.mjs';

// This command never publishes. Without --download it also works on retained assets.
const { values } = parseArgs({ options: { tag: { type: 'string' }, version: { type: 'string', default: '' },
    directory: { type: 'string' }, download: { type: 'boolean' }, 'registry-state': { type: 'string' } } });
const version = nightlyVersion(values.tag, values.version);
const directory = values.directory;
if (!directory) throw new Error('--directory is required');
const commit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${values.tag}^{commit}`], { encoding: 'utf8' }).trim();
if (values.download) {
    mkdirSync(directory, { recursive: true });
    const download = (names) => execFileSync('gh', ['release', 'download', values.tag, '--repo', process.env.GITHUB_REPOSITORY,
        '--dir', directory, ...names.flatMap((name) => ['--pattern', name])], { stdio: 'inherit' });
    download(['release-manifest.json', 'npm-manifest.json']);
    const manifest = JSON.parse(readFileSync(join(directory, 'npm-manifest.json'), 'utf8'));
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 16) throw new Error('Invalid npm artifact list');
    const names = manifest.artifacts.map((item) => item.name);
    if (names.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(name))) throw new Error('Invalid npm artifact name');
    download(names);
}
const registry = values['registry-state'] ? JSON.parse(readFileSync(values['registry-state'], 'utf8')) : npmPublicationState(version);
const { manifest, ...plan } = await resolveNightly({ directory, tag: values.tag, requestedVersion: values.version, commit, registry });
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
process.stdout.write(plan.needed ? `Would publish ${plan.tarball} under npm nightly with provenance.\n` : 'Already published with identical bytes; no publication or tag movement.\n');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `needed=${plan.needed}\nversion=${version}\nchannel=nightly\ncommit=${commit}\nrun_id=${plan.runId}\n`);
