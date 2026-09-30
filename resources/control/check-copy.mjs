#!/usr/bin/env node
// Published with @trymuxr/cli so the marketplace mirror checks the release
// it installs, rather than another independently maintained manifest.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const write = args[0] === '--write';
if (write) args.shift();
if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('usage: node resources/control/check-copy.mjs [--write] <plugin-directory>\n');
    process.exitCode = 1;
} else {
    try {
        const canonical = readFileSync(join(root, 'herdr-plugin.toml'), 'utf8');
        const marketplace = canonical.replaceAll('"./run.mjs"', '"./node_modules/@trymuxr/cli/resources/control/run.mjs"');
        const destination = join(resolve(args[0]), 'herdr-plugin.toml');
        if (write) {
            writeFileSync(destination, marketplace);
        } else if (readFileSync(destination, 'utf8') !== marketplace) {
            throw new Error('herdr-plugin.toml differs from @trymuxr/cli marketplace manifest; regenerate it with check-copy.mjs --write <plugin-directory>');
        }
        process.stdout.write(write
            ? 'muxr.control marketplace manifest generated from the published canonical source\n'
            : 'muxr.control marketplace manifest matches the published canonical source\n');
    } catch (error) {
        process.stderr.write(`muxr control copy: ${error.message}\n`);
        process.exitCode = 1;
    }
}
