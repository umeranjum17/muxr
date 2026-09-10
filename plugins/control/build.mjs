#!/usr/bin/env node
/**
 * Herdr plugin build hook (runs on `herdr plugin install`).
 *
 * Bootstraps the pinned muxr payload through the existing trusted release
 * path — never vendored into the plugin dir (herdr git installs have no
 * integrity verification). Never uses sudo. Daemon ownership stays with the
 * systemd/launchd unit muxr already writes; the [[startup]] hook only kicks
 * a configured service.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
    process.stderr.write(`muxr plugin build: ${message}\n`);
    process.exit(1);
};

const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    fail(`node 22+ is required (found ${process.version}); install it, then rerun \`herdr plugin install muxr\``);
}
if (process.env.MUXR_BIN?.trim()) {
    process.stdout.write(`muxr plugin build: using MUXR_BIN=${process.env.MUXR_BIN.trim()}\n`);
    process.exit(0);
}

const propertyCli = resolve(root, '../../cli.mjs');
const sourceCli = resolve(root, '../../scripts/cli.mjs');
if (existsSync(propertyCli) || existsSync(sourceCli)) {
    process.stdout.write('muxr plugin build: using the checkout CLI; nothing to install.\n');
    process.exit(0);
}

// Pinned payload via the trusted npm release path. `muxr update` remains the
// single update owner after this; rollback is `muxr update --to <version>`.
const pin = process.env.MUXR_CLI_PIN?.trim() || 'latest';
if (process.env.SUDO_USER || process.env.SUDO_UID) fail('refusing to run under sudo; rerun as your user');
const install = spawnSync('npm', ['install', '--global', '--ignore-scripts', `@trymuxr/cli@${pin}`], { stdio: 'inherit' });
if (install.status !== 0) fail(`npm install -g @trymuxr/cli@${pin} failed; install it manually, then rerun`);
const version = (() => {
    try {
        const check = spawnSync('muxr', ['version'], { encoding: 'utf8' });
        return (check.stdout || '').trim();
    } catch { return undefined; }
})();
process.stdout.write(`muxr plugin build: installed @trymuxr/cli@${pin}${version ? ` (muxr ${version})` : ''}.\n`);
