import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBootstrap, daemonIsRunning, daemonMode, runDaemon, restartSelfhostRelayIfRunning, stopSelfhostRelayIfRunning } from '../../setup/index.mjs';
import { compareVersions, channelTags, releaseVersion, resolveChannel } from '../domain/channel.mjs';

const PACKAGE = '@trymuxr/cli';

function currentVersion() {
    const require = createRequire(import.meta.url);
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
        const manifest = join(directory, 'package.json');
        if (existsSync(manifest)) {
            try { return require(manifest).version; }
            catch { /* keep walking */ }
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return undefined;
}

function installedPackageRoot() {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
        if (existsSync(join(directory, 'cli.mjs')) && existsSync(join(directory, 'package.json'))) return directory;
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return undefined;
}

function npm(args, stdio = 'pipe') {
    return spawnSync(process.env.MUXR_NPM_BIN?.trim() || 'npm', args, {
        encoding: stdio === 'pipe' ? 'utf8' : undefined,
        stdio,
    });
}

function activePackageUsesCurrentNpmPrefix() {
    const packageRoot = installedPackageRoot();
    // Source checkouts are not global npm installations.
    if (packageRoot === undefined) return true;
    const root = npm(['root', '--global']);
    if (root.status !== 0) {
        process.stderr.write(`Could not read npm's global root: ${(root.stderr || root.stdout || 'npm failed').trim()}\n`);
        return false;
    }
    try {
        if (realpathSync(packageRoot) === realpathSync(join(root.stdout.trim(), '@trymuxr', 'cli'))) return true;
    } catch { /* mismatch or missing path: report below */ }
    process.stderr.write('The active muxr belongs to a different npm prefix. Re-enter the Node environment that installed it, then rerun `muxr update`.\n');
    return false;
}

export async function updateCli(command = {}) {
    const current = currentVersion();
    let channel;
    let installedChannel;
    let targetVersion;
    let retired;
    try {
        const installed = releaseVersion(current);
        installedChannel = installed.channel;
        // A beta or dev install is a nightly install now; the name changed, the
        // work continues there. Nothing is downgraded to make that true.
        retired = installed.legacy === true;
        const requestedChannel = command.channel === undefined ? { channel: installedChannel } : resolveChannel(command.channel);
        channel = requestedChannel.channel;
        if (requestedChannel.from !== undefined) {
            process.stdout.write(`The ${requestedChannel.from} channel is retired; its work continues on nightly.\n`);
        }
        if (command.targetVersion !== undefined) {
            const requested = releaseVersion(command.targetVersion);
            if (requested.channel !== channel) throw new Error('Exact version belongs to a different channel; pass --channel explicitly to switch.');
            targetVersion = requested.version;
        }
    } catch (cause) {
        process.stderr.write(`${cause.message}\n`);
        return 1;
    }
    const tag = channelTags[channel];
    const lookup = npm(targetVersion === undefined
        ? ['view', PACKAGE, `dist-tags.${tag}`, '--json']
        : ['view', `${PACKAGE}@${targetVersion}`, 'version', '--json']);
    if (lookup.status !== 0) {
        process.stderr.write(`Could not check npm: ${(lookup.stderr || lookup.stdout || 'npm failed').trim()}\n`);
        return 1;
    }

    let latest;
    try { latest = JSON.parse(lookup.stdout.trim()); }
    catch { latest = lookup.stdout.trim(); }
    try {
        if (targetVersion !== undefined && latest !== targetVersion) throw new Error('exact version mismatch');
        const offered = releaseVersion(latest);
        if (offered.channel !== channel) throw new Error('channel mismatch');
        // A retired name must not arrive as the current nightly. Installing one
        // stays possible, but only when the user pins it with --to.
        if (targetVersion === undefined && offered.legacy === true) throw new Error('retired version on an active channel');
    } catch {
        process.stderr.write('npm returned an invalid version for the requested muxr channel or exact target\n');
        return 1;
    }
    const comparison = compareVersions(latest, current);
    if (comparison === undefined) {
        process.stderr.write('installed muxr version is invalid\n');
        return 1;
    }
    if (comparison === 0 || comparison < 0 && !command.allowDowngrade) {
        process.stdout.write(comparison === 0
            ? `muxr ${current} is current on ${channel}.\n`
            : `muxr ${current} is newer than ${channel} (${latest}); nothing changed. Use --allow-downgrade only after checking state compatibility.\n`);
        return 0;
    }

    process.stdout.write(`muxr ${latest} is available on ${channel} (installed: ${current}, ${installedChannel}).\n`);
    if (retired) process.stdout.write(`${current} came from a retired channel; nightly continues it, and its published packages stay available.\n`);
    if (channel !== installedChannel) process.stdout.write('This explicitly switches the current installation and its managed services; it does not create a second isolated host.\n');
    if (command.checkOnly) return 0;
    const installedMode = daemonMode();
    let approved = command.yes === true;
    if (!approved && command.confirm) {
        process.stdout.write([
            'Update plan:',
            `  • install ${PACKAGE}@${latest}`,
            installedMode === 'relay'
                ? '  • leave Herdr and agent integrations unchanged on this relay-only server'
                : '  • ensure the Herdr server is running and relink bundled plugins',
            '  • restart the muxr relay and host if they are running',
            '',
        ].join('\n'));
        approved = await command.confirm({ latest, current }) === true;
    }
    if (!approved) {
        process.stdout.write(`Nothing changed. Run \`muxr update --channel ${channel}${targetVersion === undefined ? '' : ` --to ${targetVersion}`}${command.allowDowngrade ? ' --allow-downgrade' : ''} --yes\` when ready.\n`);
        return 0;
    }

    if (!activePackageUsesCurrentNpmPrefix()) return 1;
    const restart = daemonIsRunning();
    const restartMode = installedMode;
    const install = npm(['install', '--global', '--ignore-scripts', `${PACKAGE}@${latest}`], 'inherit');
    if (install.status !== 0) return install.status ?? 1;

    if (restartMode !== 'relay' && (await runBootstrap(['--no-install-herdr'])) !== 0) {
        process.stderr.write('The package updated, but the Herdr/plugin refresh failed. Run `muxr doctor`.\n');
        return 1;
    }
    let relayRestarted = false;
    try {
        if (restart) {
            if ((await runDaemon(['stop'])) !== 0) throw new Error('host service did not stop');
            // Re-pin the unit's node/CLI paths before starting again: version
            // managers prune old runtimes (the 203/EXEC boot failure) and an
            // interrupted update can leave the unit disabled. Advisory: a
            // drifted or hand-edited unit must not turn an update into an
            // outage — the start below still uses the existing unit.
            if ((await runDaemon(['install', ...(restartMode === undefined ? [] : ['--mode', restartMode])])) !== 0) {
                process.stderr.write('warn: service re-registration was skipped (unit drifted?); run `muxr doctor` before the next reboot\n');
            }
            if (restartMode === 'selfhost' || restartMode === 'relay') relayRestarted = await stopSelfhostRelayIfRunning();
            if ((await runDaemon(['start'])) !== 0) throw new Error('host service did not start');
            relayRestarted = restartMode === 'selfhost' || restartMode === 'relay';
        } else {
            relayRestarted = await restartSelfhostRelayIfRunning();
        }
    } catch (cause) {
        process.stderr.write(`The package updated, but the managed services did not restart: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        return 1;
    }
    const parts = [];
    if (relayRestarted) parts.push('relay');
    if (restart) parts.push('host');
    const restarted = parts.join(' and ');
    process.stdout.write(`Updated muxr to ${latest}${restarted ? ` and restarted the ${restarted}` : ''}.\n`);
    return 0;
}

export { compareVersions };
