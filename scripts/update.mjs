import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { daemonIsRunning, daemonMode, restartSelfhostRelayIfRunning, runBootstrap, runDaemon, stopSelfhostRelayIfRunning } from './local-setup.mjs';
import { select } from './setup-ui.mjs';

const PACKAGE = '@trymuxr/cli';

function currentVersion() {
    const require = createRequire(import.meta.url);
    try { return require('./package.json').version; }
    catch { return require('../package.json').version; }
}

function npm(args, stdio = 'pipe') {
    return spawnSync(process.env.MUXR_NPM_BIN?.trim() || 'npm', args, {
        encoding: stdio === 'pipe' ? 'utf8' : undefined,
        stdio,
    });
}

export function compareVersions(left, right) {
    const parse = (value) => {
        const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
        return match && { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') };
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) return undefined;
    for (let index = 0; index < 3; index += 1) {
        if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
    }
    if (a.prerelease === undefined && b.prerelease === undefined) return 0;
    if (a.prerelease === undefined) return 1;
    if (b.prerelease === undefined) return -1;
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftIdentifier = a.prerelease[index];
        const rightIdentifier = b.prerelease[index];
        if (leftIdentifier === rightIdentifier) continue;
        if (leftIdentifier === undefined) return -1;
        if (rightIdentifier === undefined) return 1;
        const leftNumeric = /^\d+$/.test(leftIdentifier);
        const rightNumeric = /^\d+$/.test(rightIdentifier);
        if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    return 0;
}

export async function runUpdate(args = []) {
    const current = currentVersion();
    const lookup = npm(['view', PACKAGE, 'dist-tags.latest', '--json']);
    if (lookup.status !== 0) {
        process.stderr.write(`Could not check npm: ${(lookup.stderr || lookup.stdout || 'npm failed').trim()}\n`);
        return 1;
    }

    let latest;
    try { latest = JSON.parse(lookup.stdout.trim()); }
    catch { latest = lookup.stdout.trim(); }
    if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) {
        process.stderr.write('npm returned an invalid muxr version\n');
        return 1;
    }
    const comparison = compareVersions(latest, current);
    if (comparison === undefined) {
        process.stderr.write('installed muxr version is invalid\n');
        return 1;
    }
    if (comparison <= 0) {
        process.stdout.write(comparison === 0
            ? `muxr ${current} is current.\n`
            : `muxr ${current} is newer than npm latest (${latest}); nothing changed.\n`);
        return 0;
    }

    process.stdout.write(`muxr ${latest} is available (installed: ${current}).\n`);
    if (args.includes('--check')) return 0;
    const installedMode = daemonMode();

    let approved = args.includes('--yes');
    if (!approved && process.stdin.isTTY && process.stdout.isTTY) {
        process.stdout.write([
            'Update plan:',
            `  • install ${PACKAGE}@${latest}`,
            installedMode === 'relay'
                ? '  • leave Herdr and agent integrations unchanged on this relay-only server'
                : '  • ensure the Herdr server is running and relink bundled plugins',
            '  • restart the muxr relay and host if they are running',
            '',
        ].join('\n'));
        approved = await select('Apply this update?', [
            { value: false, title: 'Not now', description: 'leave this installation unchanged' },
            { value: true, title: 'Update muxr', description: `install ${PACKAGE}@${latest} and apply the plan above` },
        ]) === true;
    }
    if (!approved) {
        process.stdout.write(`Nothing changed. Run \`muxr update --yes\` when ready.\n`);
        return 0;
    }

    const restart = daemonIsRunning();
    const restartMode = installedMode;
    const install = npm(['install', '-g', `${PACKAGE}@${latest}`], 'inherit');
    if (install.status !== 0) return install.status ?? 1;

    if (restartMode !== 'relay' && (await runBootstrap(['--no-install-herdr'])) !== 0) {
        process.stderr.write('The package updated, but plugin refresh failed. Run `muxr doctor`.\n');
        return 1;
    }
    let relayRestarted = false;
    try {
        if (restart) {
            if ((await runDaemon(['stop'])) !== 0) throw new Error('host service did not stop');
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
    const restarted = [relayRestarted ? 'relay' : '', restart ? 'host' : ''].filter(Boolean).join(' and ');
    process.stdout.write(`Updated muxr to ${latest}${restarted ? ` and restarted the ${restarted}` : ''}.\n`);
    return 0;
}
