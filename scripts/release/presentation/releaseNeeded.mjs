import { appendFileSync, readFileSync } from 'node:fs';
import { releaseVersion } from '../domain/channel.mjs';
import { versionOnNpm } from '../application/publishNpm.mjs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const { channel } = releaseVersion(version);
const needed = !versionOnNpm(version);
process.stdout.write(`@trymuxr/cli@${version} ${needed ? 'is not on npm yet' : 'is already on npm'}\n`);
appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\nversion=${version}\nchannel=${channel}\n`);
