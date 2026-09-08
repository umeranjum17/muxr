#!/usr/bin/env node
import { prepareChangelog } from '../application/prepareChangelog.mjs';

const [mode, ...rest] = process.argv.slice(2);
if (!['validate', 'generate', 'check'].includes(mode)) {
    console.error('usage: changelog.mjs validate|generate|check --version <v> --channel <c> --commit <sha> [--directory <dir>] [--build <code>]');
    process.exit(2);
}
const options = {};
for (let index = 0; index < rest.length; index += 2) options[rest[index].replace(/^--/, '')] = rest[index + 1];

const { entry } = prepareChangelog({
    mode,
    version: options.version,
    channel: options.channel,
    commit: options.commit,
    buildCode: options.build,
    directory: options.directory,
});
console.log(`${mode}: app version ${entry.appVersion} — ${entry.title}`);
