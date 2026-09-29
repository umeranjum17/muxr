#!/usr/bin/env node
// `herdr plugin install` runs this in the fresh checkout before it registers
// the plugin (a linked pack never builds). The git tree holds no bundles, so
// it installs the published CLI of the release this checkout is tagged as;
// npm verifies the tarball against the registry's integrity hash.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
    process.stderr.write(`muxr plugin build: ${message}\n`);
    process.exit(1);
};

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`Node.js 22 or newer is required; this is ${process.version}. Install it, then reinstall the plugin.`);

/**
 * Herdr checks out `--ref` detached, so the tag survives only in FETCH_HEAD
 * ("<sha>\t\ttag 'v1.2.3' of https://…"). A branch or bare commit names no
 * release, and building an unpinned CLI would mix versions silently.
 */
function releaseTag() {
    let fetched = '';
    try { fetched = readFileSync(join(root, '..', '..', '.git', 'FETCH_HEAD'), 'utf8'); } catch { /* not a Herdr checkout */ }
    return /\ttag 'v(\d+\.\d+\.\d+[^']*)' of /.exec(fetched)?.[1];
}

// MUXR_PLUGIN_CLI_PACKAGE names an exact package (a version or a packed
// tarball) for a lab or a mirror; otherwise the tag decides.
const version = releaseTag();
const spec = process.env.MUXR_PLUGIN_CLI_PACKAGE?.trim() || (version === undefined ? undefined : `@trymuxr/cli@${version}`);
if (spec === undefined) fail('install a release: herdr plugin install umeranjum17/muxr/resources/control --ref vX.Y.Z');

const npm = process.env.MUXR_NPM_BIN?.trim() || 'npm';
const installed = spawnSync(npm, ['install', '--prefix', root, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', spec], { stdio: 'inherit' });
if (installed.error) fail(`${npm} could not run: ${installed.error.message}`);
if (installed.status !== 0) fail(`could not install ${spec}`);
process.stdout.write(`muxr plugin build: installed ${spec}\n`);
