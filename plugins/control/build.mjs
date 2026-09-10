#!/usr/bin/env node
/**
 * Herdr plugin build hook (runs on `herdr plugin install`).
 *
 * Bootstraps one exact muxr payload through the trusted npm release path.
 * The runtime is never vendored into the plugin dir (herdr git installs have
 * no integrity verification), never uses sudo, and `muxr update` remains the
 * single update owner afterwards. Daemon ownership stays with the
 * systemd/launchd unit muxr already writes; the [[startup]] hook only kicks
 * a configured service.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
    process.stderr.write(`muxr plugin build: ${message}\n`);
    process.exit(1);
};

const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    fail(`node 22+ is required (found ${process.version}); install it, then rerun \`herdr plugin install muxr\``);
}

// Explicit binary always wins; nothing to install or verify.
if (process.env.MUXR_BIN?.trim()) {
    process.stdout.write(`muxr plugin build: using MUXR_BIN=${process.env.MUXR_BIN.trim()}\n`);
    process.exit(0);
}

// Pin to one exact version: an explicit MUXR_CLI_PIN, else the version of
// the muxr checkout this plugin ships in (anchored by scripts/cli.mjs, so a
// bare repo/subdir checkout without a built tree still resolves). `latest`
// and tags are rejected: the payload must be reproducible.
let pin = process.env.MUXR_CLI_PIN?.trim() || undefined;
if (pin !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pin)) {
    fail(`MUXR_CLI_PIN must be an exact version like 0.1.25 (got ${pin})`);
}
if (pin === undefined) {
    let directory = root;
    for (let depth = 0; depth < 6; depth += 1) {
        if (existsSync(join(directory, 'scripts', 'cli.mjs')) && existsSync(join(directory, 'package.json'))) {
            try {
                const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
                if (typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
                    pin = manifest.version;
                }
            } catch {
                // Unreadable manifest: fall through to the clear failure below.
            }
            break;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
}
if (pin === undefined) {
    fail('cannot determine the pinned CLI version (no muxr checkout package.json, no MUXR_CLI_PIN); set MUXR_CLI_PIN=<exact version>');
}

const installed = (() => {
    try {
        const check = spawnSync('muxr', ['version'], { encoding: 'utf8', timeout: 15_000 });
        return check.status === 0 ? check.stdout.trim().split('\n').pop() : undefined;
    } catch {
        return undefined;
    }
})();
if (installed === pin) {
    process.stdout.write(`muxr plugin build: @trymuxr/cli@${pin} already installed; nothing changed.\n`);
    process.exit(0);
}

if (process.env.SUDO_USER || process.env.SUDO_UID) {
    fail('refusing to run under sudo; rerun as your user');
}
const install = spawnSync('npm', ['install', '--global', '--ignore-scripts', `@trymuxr/cli@${pin}`], { stdio: 'inherit' });
if (install.status !== 0) fail(`npm install -g @trymuxr/cli@${pin} failed; install it manually, then rerun`);
const after = (() => {
    try {
        const check = spawnSync('muxr', ['version'], { encoding: 'utf8', timeout: 15_000 });
        return check.status === 0 ? check.stdout.trim().split('\n').pop() : undefined;
    } catch {
        return undefined;
    }
})();
if (after !== pin) fail(`installed muxr reports ${after ?? 'nothing'}; expected ${pin}`);
process.stdout.write(`muxr plugin build: installed @trymuxr/cli@${pin}.\n`);
