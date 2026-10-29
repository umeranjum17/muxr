import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { distribution } from '../domain/channel.mjs';
import { resolveStable } from '../application/resolveStable.mjs';
import { npmPublicationState } from '../application/publishNpm.mjs';
import { downloadSealedNpm } from '../infrastructure/downloadSealedNpm.mjs';

const { values } = parseArgs({ options: { version: { type: 'string' }, directory: { type: 'string' },
    download: { type: 'boolean' }, 'requested-version': { type: 'string' },
    'owner-authorized': { type: 'boolean', default: false }, 'captain-tested': { type: 'boolean', default: false },
    'nightly-tag': { type: 'string', default: '' } } });
distribution(values.version, 'stable');
if (values['nightly-tag']) throw new Error('sealed_release cannot be combined with nightly_tag');
if (values['owner-authorized'] === values['captain-tested'] || values['requested-version'] !== values.version) {
    throw new Error('sealed_release requires exactly one of owner_authorized or captain_tested and version naming the same release');
}
if (process.env.GITHUB_REF !== 'refs/heads/main' && process.env.GITHUB_REF !== `refs/tags/v${values.version}`) throw new Error('Dispatch sealed_release from main or its matching release tag');
if (!values.directory) throw new Error('--directory is required');
const tag = `v${values.version}`;
const commit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' }).trim();
if (values.download) downloadSealedNpm({ directory: values.directory, tag });
const { manifest, ...plan } = await resolveStable({ directory: values.directory, version: values.version, commit, registry: npmPublicationState(values.version) });
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
process.stdout.write(plan.needed ? `Would publish ${plan.tarball} under npm latest with provenance; acceptance is still required.\n` : 'Already published with identical bytes; no publication.\n');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `needed=${plan.needed}\nversion=${plan.version}\nchannel=stable\ncommit=${plan.commit}\nrun_id=${plan.runId}\n`);
