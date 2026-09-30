#!/usr/bin/env node
// Published with @trymuxr/cli so the marketplace mirror checks the release
// it installs, rather than another independently maintained manifest.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1) {
    process.stderr.write('usage: node resources/control/check-copy.mjs <plugin-directory>\n');
    process.exitCode = 1;
} else {
    try {
        const canonical = readFileSync(join(root, 'herdr-plugin.toml'));
        const copy = readFileSync(join(resolve(args[0]), 'herdr-plugin.toml'));
        if (!canonical.equals(copy)) {
            throw new Error('herdr-plugin.toml differs from @trymuxr/cli resources/control; copy the published manifest into the marketplace repository');
        }
        process.stdout.write('muxr.control manifest matches the published canonical copy\n');
    } catch (error) {
        process.stderr.write(`muxr control copy: ${error.message}\n`);
        process.exitCode = 1;
    }
}
