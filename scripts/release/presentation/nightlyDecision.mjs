import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { downloadSealedNpm } from '../infrastructure/downloadSealedNpm.mjs';
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
if (values.download) downloadSealedNpm({ directory, tag: values.tag });
const registry = values['registry-state'] ? JSON.parse(readFileSync(values['registry-state'], 'utf8')) : npmPublicationState(version);
const { manifest, ...plan } = await resolveNightly({ directory, tag: values.tag, requestedVersion: values.version, commit, registry });
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
process.stdout.write(plan.needed ? `Would publish ${plan.tarball} under npm nightly with provenance.\n` : 'Already published with identical bytes; no publication or tag movement.\n');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `needed=${plan.needed}\nversion=${version}\nchannel=nightly\ncommit=${commit}\nrun_id=${plan.runId}\n`);
