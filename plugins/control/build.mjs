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
 * always reported) > `muxr` on PATH already at the resolved version >
 * fresh exact npm install. The version is resolved from the registry once
 * (`latest`, or the exact MUXR_CLI_PIN candidate/test override) together
 * with its integrity, and both are recorded. The runtime is never vendored into the plugin
 * dir (herdr git installs have no integrity verification), never uses sudo,
 * and `muxr update` remains the single update owner afterwards. Daemon
 * ownership stays with the systemd/launchd unit muxr already writes; the
 * [[startup]] hook only kicks a configured service.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installCommand, muxrVersion, writeRuntimeRecord } from './runtimeRecord.mjs';

const fail = (message) => {
    process.stderr.write(`muxr plugin build: ${message}\n`);
    process.exit(1);
};

const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    fail(`node 22+ is required (found ${process.version}); install it, then rerun \`${installCommand()}\``);
}

function whichMuxr() {
    // `command` is a shell builtin, not an executable: look it up through sh.
    const probe = spawnSync('sh', ['-c', 'command -v muxr'], { encoding: 'utf8', timeout: 10_000 });
    const found = probe.status === 0 ? probe.stdout.trim().split('\n').pop()?.trim() : undefined;
    return found === '' ? undefined : found;
}

// Resolve ONE exact version from the registry: an explicit MUXR_CLI_PIN
// (candidate/test override), else whatever `latest` names right now. Tags
// never reach the install line; the exact version and its integrity do, so
// the payload is reproducible and reportable.
const PACKAGE = '@trymuxr/cli';
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const requested = process.env.MUXR_CLI_PIN?.trim() || undefined;
if (requested !== undefined && !EXACT.test(requested)) {
    fail(`MUXR_CLI_PIN must be an exact version like 0.1.28 (got ${requested})`);
}
if (process.env.SUDO_USER || process.env.SUDO_UID) {
    fail('refusing to run under sudo; rerun as your user');
}
const lookup = spawnSync('npm', ['view', `${PACKAGE}@${requested ?? 'latest'}`, 'version', 'dist.integrity', '--json'], { encoding: 'utf8', timeout: 60_000 });
if (lookup.status !== 0) fail(`could not resolve ${PACKAGE}@${requested ?? 'latest'} from the npm registry: ${(lookup.stderr || lookup.stdout || 'npm failed').trim().slice(0, 300)}`);
let resolved;
try {
    const parsed = JSON.parse(lookup.stdout.trim());
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    resolved = { version: entry?.version, integrity: entry?.['dist.integrity'] };
} catch {
    resolved = undefined;
}
if (resolved === undefined || !EXACT.test(String(resolved.version)) || typeof resolved.integrity !== 'string' || !resolved.integrity.startsWith('sha')) {
    fail(`the npm registry answered without an exact version and integrity for ${PACKAGE}@${requested ?? 'latest'}`);
}
if (requested !== undefined && resolved.version !== requested) fail(`registry offered ${resolved.version} for the pinned ${requested}`);
const pin = resolved.version;
const integrity = resolved.integrity;

/** Integrity npm recorded for the installed global copy, when it recorded one. */
function installedIntegrity() {
    const rootProbe = spawnSync('npm', ['root', '--global'], { encoding: 'utf8', timeout: 30_000 });
    if (rootProbe.status !== 0) return undefined;
    try {
        const lock = JSON.parse(readFileSync(join(rootProbe.stdout.trim(), '.package-lock.json'), 'utf8'));
        return lock?.packages?.[`node_modules/${PACKAGE}`]?.integrity;
    } catch {
        return undefined;
    }
}

function recordRuntime(bin, source, verifiedIntegrity) {
    try {
        writeRuntimeRecord({ bin, version: pin, source, ...(verifiedIntegrity === undefined ? {} : { integrity: verifiedIntegrity }) });
    } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause));
    }
    process.stdout.write([
        `muxr plugin build: plugin actions will execute ${bin} @ ${pin} (source: ${source}${verifiedIntegrity === undefined ? '' : `, integrity ${verifiedIntegrity}`}).`,
        'Next: open the Setup pane and follow it:',
        '  herdr plugin pane open --plugin muxr.control --entrypoint setup',
        '',
    ].join('\n'));
}

// Explicit dev override: obvious, reported, and re-verified (not trusted blind).
const devBin = process.env.MUXR_BIN?.trim();
if (devBin) {
    recordRuntime(devBin, 'MUXR_BIN dev override');
    process.exit(0);
}

const onPath = whichMuxr();
if (onPath !== undefined && muxrVersion(onPath) === pin) {
    recordRuntime(onPath, '`muxr` on PATH at the resolved version', installedIntegrity());
    process.exit(0);
}

const install = spawnSync('npm', ['install', '--global', '--ignore-scripts', `${PACKAGE}@${pin}`], { stdio: 'inherit' });
if (install.status !== 0) fail(`npm install -g ${PACKAGE}@${pin} failed; fix the npm error above, then rerun \`${installCommand(pin)}\``);
const after = whichMuxr();
if (after === undefined) fail(`installed ${PACKAGE}@${pin} but no \`muxr\` is on PATH afterwards; add npm's global bin directory to PATH, then rerun`);
const recordedIntegrity = installedIntegrity();
if (recordedIntegrity !== undefined && recordedIntegrity !== integrity) {
    fail(`installed ${PACKAGE}@${pin} has integrity ${recordedIntegrity}, but the registry lists ${integrity}; refusing to record it`);
}
recordRuntime(after, `npm install -g ${PACKAGE}@${pin}`, integrity);
