import { spawn, spawnSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
    HERDR_INSTALL_HINT,
    HERDR_INSTALL_URL,
    INTEGRATION_COMMANDS,
    MIN_HERDR,
    atomicWrite,
    backup,
    env,
    error,
    ensurePrivateDir,
    executable,
    home,
    loadManifest,
    platform,
    print,
    realpathOrUndefined,
    removeManaged,
    run,
    saveManifest,
    stateDir,
    xml,
} from './runtime.mjs';
import { pluginFolder, pluginsRoot } from './paths.mjs';
import { parseBundledPlugin } from '../../plugin/index.mjs';

const bundledPluginPath = (name) => pluginFolder(name);

export function bundledPlugins() {
    const dir = pluginsRoot();
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'herdr-plugin.toml')))
        .map((entry) => {
            const manifest = readFileSync(join(dir, entry.name, 'herdr-plugin.toml'), 'utf8');
            const id = manifest.match(/^id\s*=\s*"([^"]+)"/m)?.[1];
            const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
            const parsed = parseBundledPlugin(id, entry.name);
            if (!parsed.ok || version === undefined) throw new Error(`plugins/${entry.name}/herdr-plugin.toml is missing id or version`);
            return { id: parsed.value.id, name: parsed.value.folderName, version };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}

export function herdrBin() {
    const configured = env('HERDR_BIN');
    const selected = configured ? executable(configured) : executable('herdr') || [
        join(env('HERDR_INSTALL_DIR') || join(home(), '.local', 'bin'), 'herdr'),
        '/usr/local/bin/herdr',
    ].find((candidate) => executable(candidate));
    if (configured && selected === undefined) throw new Error(`HERDR_BIN does not resolve to an executable: ${configured}`);
    return selected === undefined ? undefined : realpathSync(resolve(selected));
}

export function parseVersion(text) {
    const match = text.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
    return match ? match.slice(1).map(Number) : undefined;
}

export function versionIsCompatible(version) {
    for (let index = 0; index < MIN_HERDR.length; index += 1) {
        if (version[index] > MIN_HERDR[index]) return true;
        if (version[index] < MIN_HERDR[index]) return false;
    }
    return true;
}

export function parseIntegrationStatus(text) {
    const statuses = new Map();
    for (const line of text.split('\n')) {
        const match = line.match(/^([^:]+):\s+([^\s(]+(?:\s+[^\s(]+)*)/);
        if (match) statuses.set(match[1], match[2].trim());
    }
    return statuses;
}

export function detectedLifecycleTargets(statuses, all = false) {
    return [...statuses.entries()].filter(([id, status]) => {
        if (all) return true;
        if (status === 'current') return true;
        return (INTEGRATION_COMMANDS[id] ?? [id]).some(executable);
    });
}

export function runHerdrInstaller() {
    const localInstaller = process.env.MUXR_HERDR_INSTALLER?.trim();
    if (localInstaller) {
        const info = lstatSync(localInstaller);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
            throw new Error('MUXR_HERDR_INSTALLER must be an executable regular file');
        }
        print(`  run reviewed local Herdr installer: ${localInstaller}`);
        const installed = spawnSync(localInstaller, [], { stdio: 'inherit' });
        if (installed.status !== 0) throw new Error('local Herdr installation failed');
        return;
    }

    const scratch = mkdtempSync(join(tmpdir(), 'muxr-herdr-install-'));
    const installer = join(scratch, 'install.sh');
    try {
        print(`  download Herdr installer: ${HERDR_INSTALL_URL}`);
        const downloaded = spawnSync('curl', ['-fsSL', HERDR_INSTALL_URL, '-o', installer], { stdio: 'inherit' });
        if (downloaded.status !== 0) throw new Error('Herdr installer download failed');
        const installed = spawnSync('sh', [installer], { stdio: 'inherit' });
        if (installed.status !== 0) throw new Error('Herdr installation failed');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

export async function ensureHerdr({ dryRun, noInstall, installRequested }) {
    let binary = herdrBin();
    if (!binary) {
        if (noInstall && installRequested) throw new Error('choose only one of --install-herdr or --no-install-herdr');
        if (noInstall) throw new Error(`herdr is missing; ${HERDR_INSTALL_HINT}`);
        if (dryRun) {
            print(`  would install Herdr from ${process.env.MUXR_HERDR_INSTALLER?.trim() || HERDR_INSTALL_URL}`);
            return undefined;
        }
        runHerdrInstaller();
        binary = herdrBin();
        if (!binary) throw new Error('herdr installed but is not on PATH; restart the shell and rerun setup');
    }
    const versionResult = run(binary, ['--version']);
    const version = parseVersion(versionResult.stdout);
    if (!versionResult.ok || !version || !versionIsCompatible(version)) {
        throw new Error(`herdr >= 0.8.0 is required; found ${versionResult.stdout || 'an unreadable version'}. Run \`herdr update\` after reviewing the upgrade.`);
    }
    print(`  ✓ herdr ${version.join('.')} (adopted; config and sessions unchanged)`);
    return binary;
}

function runBundledPluginBackfill(root, binary, enabled, dryRun) {
    const script = join(root, 'backfill.mjs');
    if (!enabled || !existsSync(script)) return;
    if (dryRun) {
        print(`  would run ${basename(root)} backfill`);
        return;
    }
    const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: { ...process.env, HERDR_BIN_PATH: binary },
        timeout: 30_000,
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `failed to backfill ${basename(root)}`);
}

export async function ensureBundledPlugins(binary, dryRun) {
    const pluginList = run(binary, ['plugin', 'list', '--json']);
    if (!pluginList.ok) throw new Error(pluginList.stderr || pluginList.stdout || 'failed to list Herdr plugins');
    let installed;
    try {
        const parsed = JSON.parse(pluginList.stdout);
        installed = parsed.result?.plugins ?? parsed.plugins;
    } catch {
        throw new Error('Herdr returned an invalid plugin list');
    }
    if (!Array.isArray(installed) || installed.some((plugin) =>
        typeof plugin?.plugin_id !== 'string' || plugin.plugin_id === ''
        || typeof plugin.plugin_root !== 'string' || plugin.plugin_root === ''
        || typeof plugin.version !== 'string' || plugin.version === ''
        || typeof plugin.enabled !== 'boolean')) {
        throw new Error('Herdr returned an invalid plugin list');
    }
    const bundled = bundledPlugins();
    const bundledRoot = realpathSync(dirname(bundledPluginPath(bundled[0].name)));
    // A registration pointing directly into our bundle directory that no longer
    // names a shipped plugin is ours to retract, whether it was renamed, merged
    // or removed. Anything the user linked from elsewhere stays untouched.
    const shipped = new Set(bundled.map((plugin) => resolve(bundledRoot, plugin.name)));
    for (const current of installed) {
        const root = resolve(current.plugin_root);
        if (dirname(root) !== bundledRoot || shipped.has(root)) continue;
        if (dryRun) { print(`  would unlink removed bundled plugin ${current.plugin_id}`); continue; }
        const unlinked = run(binary, ['plugin', 'unlink', current.plugin_id]);
        print(`  ${unlinked.ok ? '✓' : 'warn:'} unlinked removed bundled plugin ${current.plugin_id}`);
    }
    for (const { id, name, version } of bundled) {
        const current = installed.find((plugin) => plugin.plugin_id === id);
        const expected = realpathSync(bundledPluginPath(name));
        if (current && realpathOrUndefined(current.plugin_root) === expected && current.version === version) {
            print(`  ✓ ${id} ${version} Herdr plugin ready${current.enabled === true ? '' : ' (disabled)'}`);
            runBundledPluginBackfill(expected, binary, current.enabled === true, dryRun);
            continue;
        }
        const enabled = current ? current.enabled === true : true;
        if (dryRun) {
            print(`  would link ${id} from ${expected} (${enabled ? 'enabled' : 'disabled'})`);
            continue;
        }
        const linked = run(binary, ['plugin', 'link', expected, enabled ? '--enabled' : '--disabled']);
        if (!linked.ok) throw new Error(linked.stderr || linked.stdout || `failed to link ${id}`);
        const action = current ? 'updated' : 'installed';
        const disabledNote = enabled ? '' : ' (disabled)';
        print(`  ✓ ${id} ${version} Herdr plugin ${action}${disabledNote}`);
        runBundledPluginBackfill(expected, binary, enabled, false);
    }
}

/** Absolute executable paths pinned by a service file that no longer exist. */
export function staleUnitPaths(unitPath) {
    const content = readFileSync(unitPath, 'utf8');
    // systemd allows -@!:+ prefixes on the executable; strip them before
    // tokenizing or the prefix fuses with the quoted path into one token.
    const execStart = content.match(/^ExecStart=(.*)$/m)?.[1]?.replace(/^[-@!:+]+/, '');
    const tokens = execStart !== undefined
        ? [...execStart.matchAll(/"([^"]+)"|(\S+)/g)].map((match) => match[1] ?? match[2])
        : [...(content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '')
            .matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);
    const systemdHerdr = content.match(/^Environment=HERDR_BIN=(?:"([^"]+)"|(\S+))$/m);
    const plistHerdr = content.match(/<key>HERDR_BIN<\/key><string>([^<]+)<\/string>/)?.[1]
        ?.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
    return [...tokens, systemdHerdr?.[1] ?? systemdHerdr?.[2], plistHerdr]
        .filter((token) => typeof token === 'string')
        // Undo systemd %% escaping so a path containing % is not a false FAIL.
        .map((token) => token.replaceAll('%%', '%').replaceAll('\\"', '"').replaceAll('\\\\', '\\'))
        .filter((token) => token.startsWith('/') && !existsSync(token));
}

export function herdrServiceUnitPaths() {
    if (platform() === 'linux') {
        const unit = join(home(), '.config', 'systemd', 'user', 'herdr-server.service');
        return existsSync(unit) ? [unit] : [];
    }
    if (platform() === 'darwin') {
        // No known label: adopt any herdr LaunchAgent the user already has.
        const dir = join(home(), 'Library', 'LaunchAgents');
        try {
            return readdirSync(dir)
                .filter((name) => /herdr/i.test(name) && name.endsWith('.plist'))
                .map((name) => join(dir, name));
        } catch { return []; }
    }
    return [];
}

/**
 * A system upgrade can move the herdr binary while the service file pins the
 * old absolute path — the 203/EXEC boot-loop landmine. Rewrite only a
 * genuinely stale pinned path; never touch a unit whose exec still resolves.
 */
export function repairHerdrServiceUnits(binary, dryRun) {
    const repaired = [];
    for (const unitPath of herdrServiceUnitPaths()) {
        const pinned = staleUnitPaths(unitPath).find((path) => basename(path) === 'herdr');
        if (pinned === undefined || pinned === binary) continue;
        if (dryRun) {
            print(`  would repair ${unitPath}: pinned herdr ${pinned} no longer exists`);
            continue;
        }
        const content = readFileSync(unitPath, 'utf8');
        const execLine = content.match(/^ExecStart=.*$/m)?.[0]?.trim() ?? pinned;
        const updated = content.includes('ExecStart=')
            ? content.replace(/^ExecStart=.*$/m, (line) => line.replaceAll(pinned, binary))
            : content.replace(`<string>${pinned}</string>`, `<string>${xml(binary)}</string>`);
        // muxr does not own this file: back it up, write atomically, and print
        // the old exec line so the change is recoverable by hand.
        const backupPath = backup(unitPath);
        atomicWrite(unitPath, updated, statSync(unitPath).mode & 0o777);
        print(`  repaired ${unitPath}: was \`${execLine}\`, now runs ${binary} (backup: ${backupPath})`);
        repaired.push(unitPath);
        if (env('MUXR_NO_SERVICE_COMMANDS') !== '1' && platform() === 'linux') run('systemctl', ['--user', 'daemon-reload']);
    }
    return repaired;
}

export function launchdLabel(unitPath) {
    return readFileSync(unitPath, 'utf8').match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
        ?? basename(unitPath, '.plist');
}

/** Start herdr through its own service manager so it stays managed. */
export function startHerdrServiceUnits(unitPaths) {
    for (const unitPath of unitPaths) {
        if (platform() === 'darwin') {
            const domain = `gui/${process.getuid()}`;
            const service = `${domain}/${launchdLabel(unitPath)}`;
            const loaded = run('launchctl', ['print', service]);
            if (loaded.ok) {
                const unloaded = run('launchctl', ['bootout', service]);
                if (!unloaded.ok) throw new Error(unloaded.stderr || unloaded.stdout || `could not unload ${service}`);
            }
            const bootstrapped = run('launchctl', ['bootstrap', domain, unitPath]);
            if (!bootstrapped.ok) throw new Error(bootstrapped.stderr || bootstrapped.stdout || `could not load ${service}`);
            const started = run('launchctl', ['kickstart', '-k', service]);
            if (!started.ok) throw new Error(started.stderr || started.stdout || `could not start ${service}`);
        } else {
            const started = run('systemctl', ['--user', 'start', basename(unitPath)]);
            if (!started.ok) throw new Error(started.stderr || started.stdout || `could not start ${basename(unitPath)}`);
        }
    }
}

export function herdrServerIsReady(binary) {
    const scoped = run(binary, ['status', 'server', '--json'], { timeout: 500 });
    if (scoped.ok) {
        try {
            const running = JSON.parse(scoped.stdout).running;
            if (typeof running === 'boolean') return running;
        } catch {}
    }
    if (scoped.errorCode === 'ETIMEDOUT') return false;
    const plainStatus = run(binary, ['status'], { timeout: 500 });
    return plainStatus.ok && /\bserver:\s*(?:\n\s*status:\s*)?running\b/i.test(plainStatus.stdout);
}

/**
 * Make sure the herdr server is running: repair a stale service path first,
 * then start it. Idempotent — host-up calls this on every service start.
 */
export async function ensureHerdrServer(binary = herdrBin(), dryRun = false, quiet = false) {
    if (!binary) throw new Error(`herdr is missing; ${HERDR_INSTALL_HINT}`);
    const repaired = repairHerdrServiceUnits(binary, dryRun);
    if (!dryRun && repaired.length > 0 && env('MUXR_NO_SERVICE_COMMANDS') !== '1' && platform() === 'darwin') {
        startHerdrServiceUnits(repaired);
    }
    let ready = herdrServerIsReady(binary);
    if (!ready) {
        if (dryRun) {
            print('  would start the herdr server');
        } else {
            const units = env('MUXR_NO_SERVICE_COMMANDS') === '1' ? [] : herdrServiceUnitPaths();
            let logPath;
            let spawnError;
            if (units.length > 0) {
                // Start the managed unit, not a stray process: a direct spawn
                // lands in muxr.service's cgroup (`muxr daemon stop` kills
                // herdr) and races the systemd-started server at boot.
                if (repaired.length === 0 || platform() !== 'darwin') startHerdrServiceUnits(units);
            } else {
                logPath = join(stateDir(), 'logs', 'herdr.log');
                ensurePrivateDir(dirname(logPath));
                const out = openSync(logPath, 'a', 0o600);
                const server = spawn(binary, ['server'], { detached: true, stdio: ['ignore', out, out] });
                server.once('error', (cause) => { spawnError = cause; });
                server.unref();
            }
            for (let attempt = 0; attempt < 12 && !ready && spawnError === undefined; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                ready = herdrServerIsReady(binary);
            }
            if (!ready) {
                if (spawnError !== undefined) throw spawnError;
                throw new Error(units.length > 0
                    ? `herdr server did not start; check its service logs and \`muxr doctor\``
                    : `herdr server did not start; see ${logPath}`);
            }
        }
    }
    if (!quiet) print(`  ✓ herdr server ${dryRun && !ready ? 'would be started' : 'ready'}`);
    return binary;
}

export async function bootstrapHerdr(args) {
    const dryRun = args.includes('--dry-run');
    const binary = await ensureHerdr({
        dryRun,
        noInstall: args.includes('--no-install-herdr'),
        installRequested: args.includes('--install-herdr'),
    });
    if (!binary) return undefined;
    await ensureHerdrServer(binary, dryRun);
    await ensureBundledPlugins(binary, dryRun);
    return binary;
}

export async function runBootstrap(args = []) {
    try {
        const binary = await bootstrapHerdr(args);
        return binary || args.includes('--dry-run') ? 0 : 1;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runLocalPrerequisites(args = []) {
    try {
        const binary = await bootstrapHerdr(args);
        if (!binary) return args.includes('--dry-run') ? 0 : 1;
        if (args.includes('--no-integrations')) {
            print('  coding-agent integrations left unchanged');
            return 0;
        }
        const integrationArgs = ['sync', ...(args.includes('--dry-run') ? ['--dry-run'] : []), ...(args.includes('--force') ? ['--force'] : [])];
        if (args.includes('--all')) integrationArgs.push('--all');
        return await runIntegrations(integrationArgs);
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runIntegrations(args = []) {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const all = args.includes('--all');
    const uninstall = args[0] === 'uninstall';
    const binary = herdrBin();
    if (!binary && !uninstall) {
        error(`herdr is missing; ${HERDR_INSTALL_HINT}`);
        return 1;
    }
    const manifest = loadManifest();
    try {
        if (uninstall) {
            let incomplete = false;
            if (!args.includes('--quiet')) print('muxr managed integration uninstall:');
            for (const [path, entry] of Object.entries(manifest.entries)) {
                if (entry.scope === 'daemon') continue;
                removeManaged(path, entry, manifest, { dryRun, force });
            }
            saveManifest(manifest, dryRun);
            for (const target of [...manifest.herdrInstalled]) {
                if (!binary) {
                    print(`  warn: herdr is missing; lifecycle integration ${target} remains installed`);
                    incomplete = true;
                    continue;
                }
                if (!args.includes('--quiet')) print(`  ${dryRun ? 'would run' : 'run'} herdr integration uninstall ${target}`);
                if (!dryRun) {
                    const result = run(binary, ['integration', 'uninstall', target]);
                    if (!result.ok) {
                        print(`  warn: could not remove the ${target} Herdr integration while Herdr is unavailable`);
                        incomplete = true;
                        continue;
                    }
                    manifest.herdrInstalled = manifest.herdrInstalled.filter((installed) => installed !== target);
                    saveManifest(manifest, false);
                }
            }
            if (binary) {
                for (const { id } of bundledPlugins()) {
                    if (!args.includes('--quiet')) print(`  ${dryRun ? 'would run' : 'run'} herdr plugin unlink ${id}`);
                    if (!dryRun) {
                        const result = run(binary, ['plugin', 'unlink', id]);
                        if (!result.ok && !/not (?:found|installed)|unknown plugin/i.test(result.stderr || result.stdout)) {
                            print(`  warn: could not unlink ${id} while Herdr is unavailable`);
                            incomplete = true;
                        }
                    }
                }
            } else {
                print('  warn: herdr is missing; muxr.control remains registered');
                incomplete = true;
            }
            saveManifest(manifest, dryRun);
            return incomplete ? 1 : 0;
        }

        const statusResult = run(binary, ['integration', 'status']);
        if (!statusResult.ok) throw new Error(statusResult.stderr || 'herdr integration status failed');
        const statuses = parseIntegrationStatus(statusResult.stdout);
        const lifecycleTargets = detectedLifecycleTargets(statuses, all);
        print(`muxr integration sync (${lifecycleTargets.length} ${all ? 'known' : 'detected'} agent providers):`);
        saveManifest(manifest, dryRun);

        if (!dryRun) {
            const update = run(binary, ['server', 'update-agent-manifests', '--json']);
            if (!update.ok) print(`  warn: agent manifest update skipped (${update.stderr || update.stdout})`);
        } else {
            print('  would run herdr server update-agent-manifests --json');
        }
        for (const [id, status] of lifecycleTargets) {
            if (status === 'unknown') {
                print(`  warn: ${id} is not reported by this herdr build; lifecycle integration skipped`);
            } else if (status !== 'current') {
                const verb = dryRun ? 'would install' : 'installing';
                const previous = status === 'not installed' ? '' : ` (was ${status})`;
                print(`  ${verb} ${id} lifecycle integration${previous}`);
                if (!dryRun) {
                    const result = run(binary, ['integration', 'install', id]);
                    if (!result.ok) {
                        print(`  warn: ${id} lifecycle integration skipped (${result.stderr || result.stdout || 'install failed'})`);
                        continue;
                    }
                    const verified = run(binary, ['integration', 'status']);
                    const verifiedStatus = verified.ok ? parseIntegrationStatus(verified.stdout).get(id) : undefined;
                    if (verifiedStatus !== 'current') {
                        print(`  warn: ${id} lifecycle integration did not verify (${verifiedStatus ?? (verified.stderr || 'status unavailable')})`);
                        continue;
                    }
                    print(`  ✓ ${id} lifecycle integration installed and verified`);
                    if (status === 'not installed' && !manifest.herdrInstalled.includes(id)) manifest.herdrInstalled.push(id);
                }
            } else {
                print(`  ✓ ${id} lifecycle integration current`);
            }
        }
        saveManifest(manifest, dryRun);
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
