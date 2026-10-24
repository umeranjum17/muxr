import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkReleaseApk } from '../application/checkReleaseApk.mjs';
import { apkCheckPath } from '../domain/releaseJourney.mjs';

const option = (key) => {
    const index = process.argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    return process.argv[index + 1];
};
const version = option('version');
const directory = option('release');
const journeyApk = option('journey-apk');
if (!version || !directory || !journeyApk) {
    throw new Error('usage: checkReleaseApk.mjs --version <v> --release <gh release download dir> --journey-apk <x86_64 apk> [--journey-build <apk>.json] [--repo <dir>]');
}
const record = checkReleaseApk({ version, directory, journeyApk, journeyBuild: option('journey-build') ?? `${journeyApk}.json` });
const path = join(option('repo') ?? process.cwd(), apkCheckPath(version));
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${apkCheckPath(version)}: ${JSON.stringify(record.releaseApk.checks)}\n`);
if (!record.passed) process.exitCode = 1;
