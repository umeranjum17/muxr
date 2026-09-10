#!/usr/bin/env node
/**
 * Herdr plugin build hook (runs on `herdr plugin install`).
 *
 * Resolves ONE verified installed executable and records it for every
 * plugin action:
 *
 *   ~/.muxr/herdr-plugin.runtime — owner-only JSON: { bin, version }
 *
 * Resolution order: explicit MUXR_BIN (dev override, always wins and is
 * always reported) > `muxr` on PATH verified at the pinned version >
 * fresh pinned npm install. The runtime is never vendored into the plugin
 * dir (herdr git installs have no integrity verification), never uses sudo,
 * and `muxr update` remains the single update owner afterwards. Daemon
 * ownership stays with the systemd/launchd unit muxr already writes; the
 * [[startup]] hook only kicks a configured service.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const stateDir = () => process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
const runtimePath = () => join(stateDir(), 'herdr-plugin.runtime');
const fail = (message) => {
    process.stderr.write(`muxr plugin build: ${message}\n`);
    process.exit(1);
};

const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    fail(`node 22+ is required (found ${process.version}); install it, then rerun \`herdr plugin install muxr\``);
}

function muxrVersion(bin, args = ['version']) {
    try {
        const check = spawnSync(bin, args, { encoding: 'utf8', timeout: 15_000 });
        return check.status === 0 ? check.stdout.trim().split('\n').pop() : undefined;
    } catch {
        return undefined;
    }
}

function whichMuxr() {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'command', ['-v', 'muxr'], { encoding: 'utf8', timeout: 10_000 });
    const found = probe.status === 0 ? probe.stdout.trim().split('\n').pop()?.trim() : undefined;
    return found === '' ? undefined : found;
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

function recordRuntime(bin, source) {
    const version = muxrVersion(bin);
    if (version !== pin) fail(`resolved runtime ${bin} reports ${version ?? 'nothing'}; expected ${pin} (source: ${source})`);
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(runtimePath(), `${JSON.stringify({ bin, version, source, recordedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    chmodSync(runtimePath(), 0o600);
    process.stdout.write(`muxr plugin build: plugin actions will execute ${bin} @ ${pin} (source: ${source}).\n`);
}

// Explicit dev override: obvious, reported, and re-verified (not trusted blind).
const devBin = process.env.MUXR_BIN?.trim();
if (devBin) {
    recordRuntime(devBin, 'MUXR_BIN dev override');
    process.exit(0);
}

const onPath = whichMuxr();
if (onPath !== undefined && muxrVersion(onPath) === pin) {
    recordRuntime(onPath, '`muxr` on PATH at the pinned version');
    process.exit(0);
}

if (process.env.SUDO_USER || process.env.SUDO_UID) {
    fail('refusing to run under sudo; rerun as your user');
}
const install = spawnSync('npm', ['install', '--global', '--ignore-scripts', `@trymuxr/cli@${pin}`], { stdio: 'inherit' });
if (install.status !== 0) fail(`npm install -g @trymuxr/cli@${pin} failed; install it manually, then rerun`);
const after = whichMuxr();
if (after === undefined) fail(`installed @trymuxr/cli@${pin} but no \`muxr\` is on PATH afterwards`);
recordRuntime(after, `npm install -g @trymuxr/cli@${pin}`);
