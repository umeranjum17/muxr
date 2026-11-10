import {
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
    AGENT_INSTALL_HINT,
    HERDR_INSTALL_HINT,
    MIN_HERDR,
    api,
    askVisible,
    env,
    error,
    hash,
    home,
    loadManifest,
    manifestPath,
    platform,
    print,
    publicRelayUrl,
    run,
    serviceManagerRun,
    scopedHomeRefusal,
    stateDir,
    validMachineCrypto,
} from '../infrastructure/runtime.mjs';
import {
    detectedLifecycleTargets,
    ensureHerdr,
    ensureHerdrServer,
    githubPluginSource,
    herdrBin,
    herdrServerIsReady,
    herdrServiceUnitPaths,
    parseIntegrationStatus,
    parseVersion,
    productPanePack,
    runIntegrations,
    staleUnitPaths,
    versionIsCompatible,
} from '../infrastructure/herdr.mjs';
import { herdrCoreStatus } from '../infrastructure/herdrCore.mjs';
import {
    daemonMode,
    runDaemon,
    daemonState,
    serviceCommand,
} from '../infrastructure/daemon.mjs';
import {
    advertisedRelayHealthy,
    cloudflaredAlive,
    readSelfhostState,
    relayPortTaken,
    selfhostControlBase,
    selfhostPath,
    selfhostRelayHealthy,
    selfhostStateUnreadable,
} from '../infrastructure/selfhost.mjs';
import {
    hasPendingRemoteConnect,
    remoteHostOnline,
    repairSelfhostRelay,
} from '../infrastructure/selfhostRelay.mjs';
import { selfhostFileCheck, staleFileChecks, stateFolderCheck } from '../infrastructure/localState.mjs';

const FULL_UNINSTALL_ENTRIES = [
    'auth.json',
    'selfhost.json',
    'selfhost.pending.json',
    'selfhost.previous.json',
    'selfhost-rotation.lock',
    'pairing-link.txt',
    'pairing-string.txt',
    'enrollment-link.txt',
    'relay',
    'logs',
    'integrations',
    'extensions',
    'plugin-state',
    'plugin-sync.json',
    'voice',
    'operations',
    'xai.key',
    'gemini.key',
    'openai.key',
];

export function validateUninstallRoot() {
    const root = resolve(stateDir());
    if (root === resolve('/') || root === resolve(home()) || dirname(root) === root) {
        throw new Error(`refusing unsafe muxr state root: ${root}`);
    }
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
        throw new Error(`refusing symlinked muxr state root: ${root}`);
    }
    return root;
}

export async function revokeRemoteMachineForUninstall(state) {
    if (state?.relayLocation !== 'remote' || typeof state.machineCredential !== 'string') return true;
    try {
        const revoked = await api(selfhostControlBase(state), '/v1/selfhost/machine-status', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${state.machineCredential}` },
        });
        return revoked.response.ok;
    } catch { return false; }
}

/** Fully remove muxr-owned runtime authority while preserving Herdr and user artifacts. */
export async function uninstallMuxr(args = []) {
    const root = validateUninstallRoot();
    const failures = [];
    const state = readSelfhostState();
    print('Stopping muxr services…');
    if (!(await revokeRemoteMachineForUninstall(state))) {
        failures.push('The shared relay could not revoke this computer. Ask its owner to remove this machine.');
    }
    const runtimeStopped = (await runDaemon(['uninstall', '--force', '--quiet'])) === 0;
    if (!runtimeStopped) failures.push('The muxr background service or owned ingress could not be fully removed. Runtime state was kept so a running service is never stranded without its keys.');

    print('Removing muxr integrations from Herdr…');
    const integrationsRemoved = (await runIntegrations(['uninstall', '--force', '--quiet'])) === 0;
    if (!integrationsRemoved) failures.push('Some muxr-managed Herdr registrations remain. Start Herdr, then run `muxr uninstall --resume`.');

    if (runtimeStopped) {
        print('Deleting muxr pairing, relay, plugin, and runtime state…');
        for (const entry of FULL_UNINSTALL_ENTRIES) {
            const path = join(root, entry);
            try { rmSync(path, { recursive: true, force: true }); }
            catch { failures.push(`Could not remove ${entry}.`); }
        }
        const hostRoot = join(root, 'host');
        if (existsSync(hostRoot)) {
            try {
                if (lstatSync(hostRoot).isSymbolicLink()) rmSync(hostRoot, { force: true });
                else {
                    for (const name of readdirSync(hostRoot)) {
                        if (name !== 'attachments') rmSync(join(hostRoot, name), { recursive: true, force: true });
                    }
                    if (readdirSync(hostRoot).length === 0) rmSync(hostRoot, { recursive: true, force: true });
                }
            } catch { failures.push('Could not remove muxr host runtime state.'); }
        }
        if (integrationsRemoved) {
            try { rmSync(manifestPath(), { force: true }); }
            catch { failures.push('Could not remove the muxr ownership manifest.'); }
        }

        const remainingRuntime = FULL_UNINSTALL_ENTRIES.filter((entry) => existsSync(join(root, entry)));
        if (remainingRuntime.length > 0) failures.push(`Runtime entries remain: ${remainingRuntime.join(', ')}.`);
    }
    if (existsSync(root) && readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });

    if (failures.length > 0) {
        error('\nmuxr cleanup is incomplete');
        failures.forEach((failure) => error(`  • ${failure}`));
        error('\nHerdr sessions and repositories were not changed.');
        return 1;
    }

    print('\nmuxr was fully removed from this computer.');
    print('  ✓ Services and owned ingress');
    print('  ✓ Machine identity, pairings, grants, and relay authority');
    print('  ✓ muxr-managed integrations, plugins, provider keys, logs, and caches');
    print('  ✓ Herdr sessions, repositories, worktrees, received attachments, exports, and unrecognized files were kept');
    print('\nPhones and browsers may still show this computer offline. Forget it there to remove their local entry.');
    return 0;
}

/** The version of the package holding `directory`: a packed CLI, or a checkout's root. */
function packageVersion(directory) {
    for (const path of [join(directory, 'package.json'), join(directory, '..', 'package.json')]) {
        try {
            const version = JSON.parse(readFileSync(path, 'utf8')).version;
            if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) return version;
        } catch {}
    }
    return undefined;
}

export function cliVersion() {
    return packageVersion(dirname(realpathSync(process.argv[1]))) ?? 'unknown';
}

/**
 * The muxr release the registered management pack came from. A GitHub
 * install is pinned by its release tag; a linked pack sits two levels inside
 * the package or checkout that ships it.
 */
function panePackRelease(plugin) {
    if (plugin.source?.kind === 'github') {
        const ref = plugin.source.requested_ref ?? '';
        const tagged = /^v(\d+\.\d+\.\d+\S*)$/.exec(ref)?.[1];
        return { version: tagged, from: `${githubPluginSource(plugin)}@${ref || plugin.source.resolved_commit?.slice(0, 12) || 'HEAD'}` };
    }
    return { version: packageVersion(join(plugin.plugin_root, '..', '..')) ?? packageVersion(join(plugin.plugin_root, '..')), from: plugin.plugin_root };
}

function versionAgreement(cli, service, pack) {
    const known = [cli === 'unknown' ? undefined : cli, service, pack?.version].filter((version) => version !== undefined);
    const agree = known.every((version) => version === known[0]);
    const cliBehind = service !== undefined && cli !== 'unknown' && cli.localeCompare(service, 'en', { numeric: true }) < 0;
    const parts = [
        `CLI ${cli}`,
        `host ${service ?? 'not observed'}`,
        ...(pack === undefined ? [] : [`Herdr plugin ${pack.version ?? 'unpinned'} (${pack.from})`]),
    ];
    return {
        level: agree ? 'ok' : 'warn',
        detail: `${parts.join(' · ')}${agree ? '' : cliBehind
            ? ' — this CLI is older than the host; run `muxr update`'
            : ' — these copies differ; update or reinstall so the plugin, the CLI on PATH and the running host are one release before trusting validation'}`,
    };
}

export function hostServiceVersion() {
    const dataDir = env('MUXR_DATA_DIR') ?? join(stateDir(), 'host');
    const path = join(dataDir, 'diagnostics.json');
    try {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink()) return undefined;
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const current = parsed?.current?.hostVersion;
        if (typeof current === 'string' && /^\d+\.\d+\.\d+/.test(current)) return current;
        if (!Array.isArray(parsed?.events)) return undefined;
        for (let index = parsed.events.length - 1; index >= 0; index -= 1) {
            const event = parsed.events[index];
            if (event?.event === 'host.started' && typeof event.hostVersion === 'string'
                && /^\d+\.\d+\.\d+/.test(event.hostVersion)) return event.hostVersion;
        }
    } catch {}
    return undefined;
}

export function entryStatus(path, entry) {
    if (!existsSync(path)) return 'missing';
    return entry.kind === 'owned' && hash(readFileSync(path, 'utf8')) === entry.hash ? 'current' : 'drifted';
}

export function peerAgentAccessReady() {
    const path = join(stateDir(), 'host', 'peer', 'cli.json');
    if (!existsSync(path)) return false;
    try {
        const info = lstatSync(path);
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
            && value?.version === 1 && typeof value.socketPath === 'string' && typeof value.capability === 'string';
    } catch { return false; }
}

function portHolderCommand(port) {
    return platform() === 'darwin' ? `lsof -nP -iTCP:${port} -sTCP:LISTEN` : `ss -ltnp 'sport = :${port}'`;
}

function runtimeKind(managedMode) {
    return managedMode === 'relay' ? 'relay' : 'host';
}

function managedSetupReport(states, drifted) {
    if (states.length === 0) return { level: 'warn', detail: 'not installed — run `muxr setup`' };
    if (drifted.length > 0) return { level: 'fail', detail: `${drifted.join(', ')} — run \`muxr integrations sync --force\`` };
    return { level: 'ok', detail: `${states.length} entries current` };
}

function herdrSocketIssue() {
    const socket = env('HERDR_SOCKET_PATH');
    if (socket === undefined || statSync(socket, { throwIfNoEntry: false })?.isSocket()) return undefined;
    return `HERDR_SOCKET_PATH=${socket} is not a Herdr socket — unset it, or point it at a running session`;
}

async function runtimeChecks(add, managedMode) {
    let panePack;
    const major = Number(process.versions.node.split('.')[0]);
    add(major >= 22 ? 'ok' : 'fail', 'node', `v${process.versions.node}${major >= 22 ? '' : ' — needs >= 22'}`);
    const cliDir = dirname(realpathSync(process.argv[1]));
    const kind = runtimeKind(managedMode);
    const runtime = kind === 'relay'
        ? existsSync(join(cliDir, 'relay.js')) || existsSync(join(process.cwd(), 'apps', 'relay', 'dist', 'main.js'))
        : existsSync(join(cliDir, 'host.js')) || existsSync(join(process.cwd(), 'apps', 'host', 'dist', 'main.js'));
    add(runtime ? 'ok' : 'fail', kind, runtime
        ? `${kind} runtime present`
        : `missing ${kind} runtime; rebuild or reinstall muxr`);
    let binary;
    let binaryIssue;
    try { binary = managedMode === 'relay' ? undefined : herdrBin(); }
    catch (cause) {
        binaryIssue = cause instanceof Error ? cause.message : String(cause);
        add('fail', 'herdr', binaryIssue);
    }
    if (managedMode === 'relay') {
        add('ok', 'profile', 'shared relay only · Herdr and agent integrations not required');
    } else if (!binary) {
        if (binaryIssue === undefined) {
            add('fail', 'herdr', `missing — ${HERDR_INSTALL_HINT}`, {
                label: 'install and start Herdr',
                run: async () => {
                    const installed = await ensureHerdr({ dryRun: false, noInstall: false, installRequested: true });
                    await ensureHerdrServer(installed);
                },
            });
        }
    } else {
        const versionResult = run(binary, ['--version']);
        const version = parseVersion(versionResult.stdout);
        const versionOk = version !== undefined && versionIsCompatible(version);
        add(versionOk ? 'ok' : 'fail', 'herdr', versionOk
            ? versionResult.stdout
            : `${versionResult.stdout || versionResult.stderr || 'unreadable version'} — needs >= ${MIN_HERDR.join('.')}; run \`herdr update\` after reviewing the upgrade`);
        const serverReady = herdrServerIsReady(binary);
        add(serverReady ? 'ok' : 'fail', 'herdr server', serverReady
            ? 'running'
            : herdrSocketIssue() ?? 'not running — start it with `herdr server`',
            serverReady ? undefined : { label: 'start the herdr server', run: async () => { await ensureHerdrServer(binary); } });
        const integrations = run(binary, ['integration', 'status']);
        if (integrations.ok) {
            const statuses = parseIntegrationStatus(integrations.stdout);
            const detected = detectedLifecycleTargets(statuses).map(([id, status]) => `${id}:${status}`);
            const needsSync = detected.some((status) => !status.endsWith(':current'));
            if (detected.length === 0) add('fail', 'agent CLI', `none found — ${AGENT_INSTALL_HINT}`);
            else add(needsSync ? 'warn' : 'ok', 'integrations', needsSync
                ? `${detected.join(', ')} — run \`muxr integrations sync\``
                : detected.join(', '));
        } else {
            add('warn', 'integrations', `${integrations.stderr || 'status unavailable'} — run \`muxr integrations sync\``);
        }
        // `muxr plugin dev` against a temp directory leaves a permanent
        // registration. Once the directory goes the entry rots into an
        // "Unavailable" row on every connected phone, and nothing retracts it.
        const registered = run(binary, ['plugin', 'list', '--json']);
        let missing = [];
        if (registered.ok) {
            try {
                const parsed = JSON.parse(registered.stdout);
                const plugins = parsed.result?.plugins ?? parsed.plugins ?? [];
                const control = plugins.find((plugin) => plugin?.plugin_id === productPanePack().id && typeof plugin.plugin_root === 'string');
                if (control !== undefined) panePack = panePackRelease(control);
                missing = plugins
                    .filter((plugin) => typeof plugin?.plugin_id === 'string' && typeof plugin.plugin_root === 'string'
                        && !existsSync(join(plugin.plugin_root, 'herdr-plugin.toml')))
                    .map((plugin) => plugin.plugin_id);
            } catch { missing = []; }
        }
        add(missing.length ? 'warn' : 'ok', 'plugins', missing.length
            ? `${missing.length} registered but no longer on disk: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}`
            : 'every registered plugin resolves',
            missing.length ? {
                label: `unlink ${missing.length} missing plugin${missing.length === 1 ? '' : 's'}`,
                run: () => { for (const id of missing) run(binary, ['plugin', 'unlink', id]); },
            } : undefined);
    }
    return { binary, panePack };
}

function serviceChecks(add, managedMode, binary) {
    const manifest = loadManifest();
    const integrations = Object.entries(manifest.entries).filter(([, entry]) => entry.scope !== 'daemon');
    const states = integrations.map(([path, entry]) => `${path.startsWith(`${home()}/`) ? `~/${path.slice(home().length + 1)}` : basename(path)}:${entryStatus(path, entry)}`);
    const drifted = integrations
        .filter(([path, entry]) => entryStatus(path, entry) !== 'current')
        .map(([path, entry]) => `${basename(path)}:${entryStatus(path, entry)}`);
    const setup = managedSetupReport(states, drifted);
    add(setup.level, 'managed setup', setup.detail,
        drifted.length ? { label: 're-sync managed integration files', run: () => runIntegrations(['sync', '--force']) } : undefined);
    // Daemon files are installed by `muxr daemon install`, not integrations
    // sync. An alternate Node prefix changes their hash without changing the
    // running version; executable-path validity is checked separately below.
    for (const [path, entry] of Object.entries(manifest.entries).filter(([, entry]) => entry.scope === 'daemon')) {
        if (!existsSync(path)) {
            add('fail', 'muxr service registration', `${basename(path)} is missing — run \`muxr daemon install\``);
        } else if (entryStatus(path, entry) !== 'current' && staleUnitPaths(path).length === 0) {
            add('warn', 'muxr service registration', `${basename(path)} differs from its saved installation — run \`muxr daemon install\` if you want to pin this CLI's paths`);
        }
    }
    // The pinned-path landmine: a service file whose exec paths no longer
    // resolve dies 203/EXEC at boot while doctor's liveness checks stay green.
    const muxrServicePath = platform() === 'linux'
        ? join(home(), '.config', 'systemd', 'user', 'muxr.service')
        : join(home(), 'Library', 'LaunchAgents', 'com.muxr.host.plist');
    const serviceFiles = [
        ...(platform() === 'linux' || platform() === 'darwin' ? [[muxrServicePath, 'muxr service file']] : []),
        ...(managedMode === 'relay' ? [] : herdrServiceUnitPaths().map((path) => [path, 'herdr service file'])),
    ];
    for (const [servicePath, serviceName] of serviceFiles) {
        if (!existsSync(servicePath)) continue;
        const stale = staleUnitPaths(servicePath);
        if (stale.length === 0) {
            add('ok', serviceName, 'exec paths resolve');
            continue;
        }
        const isMuxr = serviceName === 'muxr service file';
        const repairable = isMuxr || binary !== undefined;
        add('fail', serviceName, `points at missing ${stale.join(', ')} — ${isMuxr
            ? 're-pin it with `muxr daemon install`'
            : repairable ? 'repair it with `muxr doctor`' : `herdr moved; ${HERDR_INSTALL_HINT}`}`,
            repairable
                ? isMuxr
                    ? { label: 're-register the muxr service with current paths', run: () => runDaemon(['install', ...(managedMode === undefined ? [] : ['--mode', managedMode])]) }
                    : { label: 'repair the herdr service file and start herdr', run: async () => { await ensureHerdrServer(binary); } }
                : undefined);
    }
    // Installed-but-disabled: works now, silently gone at the next boot.
    if (platform() === 'linux' && existsSync(muxrServicePath) && env('MUXR_NO_SERVICE_COMMANDS') !== '1') {
        const scopeRefusal = scopedHomeRefusal();
        const enabled = scopeRefusal === undefined ? serviceManagerRun('systemctl', ['--user', 'is-enabled', 'muxr.service']) : { refused: true, stderr: scopeRefusal };
        if (enabled.refused) {
            add('warn', 'service enabled', `not checked — ${enabled.stderr}`);
        } else {
            const isEnabled = enabled.stdout === 'enabled' || enabled.stdout === 'enabled-runtime';
            add(isEnabled ? 'ok' : 'fail', 'service enabled', isEnabled
                ? 'muxr.service starts at login'
                : `muxr.service is ${enabled.stdout || 'not enabled'} — it will not survive a reboot; enable it with \`muxr daemon start\``,
                isEnabled ? undefined : { label: 'enable and start the muxr service', run: () => runDaemon(['start']) });
        }
    }
    if (platform() === 'darwin' && existsSync(muxrServicePath) && env('MUXR_NO_SERVICE_COMMANDS') !== '1') {
        const loaded = serviceCommand('status');
        if (loaded.refused) {
            add('warn', 'service loaded', `not checked — ${loaded.stderr}`);
        } else {
            const definition = readFileSync(muxrServicePath, 'utf8');
            const startsAtLogin = /<key>RunAtLoad<\/key><true\/>/.test(definition);
            add(loaded.ok && startsAtLogin ? 'ok' : 'fail', 'service loaded', loaded.ok && startsAtLogin
                ? 'com.muxr.host is loaded and starts at login'
                : `${loaded.ok ? 'service is loaded but RunAtLoad is off' : 'com.muxr.host is not loaded'} — run \`muxr daemon start\``,
                loaded.ok && startsAtLogin ? undefined : { label: 'load the muxr service for login', run: () => runDaemon(['start']) });
        }
    }
}

async function selfhostChecks(add, managedMode) {
    let selfhost = readSelfhostState();
    const fileLocked = selfhostFileCheck(add);
    if (selfhostStateUnreadable() && !fileLocked) {
        add('fail', 'self-host state', `${selfhostPath()} exists but is unreadable (truncated or corrupt) — move it aside with \`mv ${selfhostPath()} ${selfhostPath()}.broken\` only after pairings are backed up; setup refuses to mint a new identity over it`);
    } else if (managedMode === 'selfhost' && selfhost !== undefined) {
        const expires = selfhost.credentialExpiresAt === undefined ? undefined : Date.parse(selfhost.credentialExpiresAt);
        const valid = typeof selfhost.machine?.id === 'string' && validMachineCrypto(selfhost.machine?.crypto, 'selfhost')
            && (typeof selfhost.mintSecret === 'string' || typeof selfhost.machineCredential === 'string')
            && (selfhost.relayLocation === 'remote' ? typeof selfhost.relayUrl === 'string' : typeof selfhost.relayPort === 'number')
            && (expires === undefined || Number.isFinite(expires) && expires > Date.now());
        if (!valid) {
            add('fail', 'self-host state', `${selfhostPath()} has an incomplete machine, crypto, or credential schema — back it up before moving it aside; setup will not overwrite it`);
            selfhost = undefined;
        }
    }
    const portTaken = await relayPortTaken(selfhost);
    const relayReady = !portTaken && await selfhostRelayHealthy(selfhost);
    const relayDetail = selfhost?.relayLocation === 'remote'
        ? publicRelayUrl(selfhost.relayUrl) ?? 'remote relay'
        : `:${selfhost?.relayPort}`;
    let relayLevel = 'warn';
    let relayDetailText = fileLocked ? 'not checked until the self-host state can be read' : 'not configured — run muxr setup';
    if (selfhost !== undefined && relayReady) {
        relayLevel = 'ok';
        relayDetailText = `reachable at ${relayDetail}`;
    } else if (portTaken) {
        relayLevel = 'fail';
        relayDetailText = `port ${selfhost.relayPort} is taken by another program — find it with \`${portHolderCommand(selfhost.relayPort)}\`, stop it, then run \`muxr daemon restart\``;
    } else if (selfhost !== undefined) {
        relayLevel = 'fail';
        relayDetailText = `configured at ${relayDetail}, not reachable — restart it with \`muxr daemon restart\``;
    }
    const relayRepair = selfhost !== undefined && !relayReady && !portTaken && selfhost.relayLocation !== 'remote'
        ? { label: 'restart the self-host relay', run: async () => {
            if ((await repairSelfhostRelay(selfhost)) !== 0) throw new Error('muxr daemon restart failed');
        } }
        : undefined;
    add(relayLevel, 'self-host relay', relayDetailText, relayRepair);
    if (selfhost !== undefined) {
        // Probe the advertised relay for real; 'external' is exempt because NAT
        // hairpin makes self-probing unreliable from the host itself.
        const ingressReady = selfhost.connectionMode === 'external'
            || ((selfhost.connectionMode !== 'cloudflare' || cloudflaredAlive(selfhost.ingress))
                && await advertisedRelayHealthy(selfhost));
        let connectionDetail;
        let connectionLevel = ingressReady ? 'ok' : 'fail';
        if (ingressReady) {
            connectionDetail = `${selfhost.connectionMode ?? 'self-host'} · ${publicRelayUrl(selfhost.relayUrl) ?? `local port ${selfhost.relayPort}`}`;
            if (selfhost.connectionMode === 'lan') {
                connectionDetail += ' · works only on this Wi-Fi — will NOT work away from home; run `muxr setup` and choose a route that works away from home';
                connectionLevel = 'warn';
            }
        } else if (selfhost.connectionMode === 'cloudflare') {
            connectionDetail = 'Cloudflare tunnel is not running; run `muxr` to restore it and pair the new endpoint';
        } else {
            connectionDetail = `advertised relay ${publicRelayUrl(selfhost.relayUrl) ?? `on local port ${selfhost.relayPort}`} is not reachable — restart with \`muxr daemon restart\` or reconfigure with \`muxr\``;
        }
        add(connectionLevel, 'connection', connectionDetail);
        const hostState = daemonState();
        const hostRunning = hostState === 'running';
        const hostAuthenticated = selfhost.relayLocation !== 'remote' || await remoteHostOnline(selfhost);
        const serviceName = managedMode === 'relay' ? 'relay service' : 'host service';
        let hostDetail = 'running but not authenticated with the shared relay — restart it with `muxr daemon restart`';
        if (hostState === 'stopped') hostDetail = 'not running — start it with `muxr daemon start`';
        else if (hostState === 'unknown') hostDetail = 'not checked — service commands are refused in this scope';
        else if (hostAuthenticated) hostDetail = 'running and authenticated';
        let hostLevel = 'fail';
        if (hostState === 'unknown') hostLevel = 'warn';
        else if (hostRunning && hostAuthenticated) hostLevel = 'ok';
        add(hostLevel, serviceName, hostDetail,
            hostState === 'stopped' ? { label: 'start and enable the muxr service', run: () => runDaemon(['start']) } : undefined);
        const devices = selfhost.machine?.crypto?.devices;
        if (Array.isArray(devices)) {
            add('ok', 'paired devices', devices.length === 0
                ? 'none yet — pair a phone with `muxr pair`'
                : `${devices.length} paired`);
        }
        if (selfhost.relayLocation === 'remote' && typeof selfhost.credentialExpiresAt === 'string') {
            const days = Math.ceil((Date.parse(selfhost.credentialExpiresAt) - Date.now()) / (24 * 60 * 60_000));
            let credentialDetail = `${days} day${days === 1 ? '' : 's'} remaining · create a fresh enrollment before expiry`;
            if (days <= 0) credentialDetail = 'expired · create a fresh enrollment on the shared relay server';
            add(days <= 30 ? 'warn' : 'ok', 'machine credential', credentialDetail);
        }
        if (selfhost.webEnabled === true) add(ingressReady ? 'ok' : 'warn', 'web client', ingressReady
            ? `${publicRelayUrl(selfhost.relayUrl)?.replace(/^ws/, 'http') ?? 'configured'} · control and view-only browser grants expire after eight hours`
            : 'configured but unreachable until the tunnel is restored');
    }
    if (managedMode !== 'relay' && selfhost !== undefined) {
        const ready = peerAgentAccessReady();
        add(ready ? 'ok' : 'fail', 'peer agent access', ready
            ? 'ready for `muxr peers`'
            : 'not ready — run `muxr daemon restart`',
        ready ? undefined : { label: 'restart muxr to restore local peer access', run: () => runDaemon(['restart']) });
    }
    if (hasPendingRemoteConnect()) add('fail', 'pending enrollment', 'run `muxr` and choose Resume remote connection');
}

/** Every check, each section fail-soft: a probe that throws costs one line, never the rest of the list. */
async function collectChecks() {
    const checks = [];
    // repair: { label, run, safe? } — offered interactively when the check fails. `safe` marks a
    // local, reversible action `--fix` may take unasked; it never reaches a service or a process.
    const add = (level, name, detail, repair) => checks.push({ level, name, detail, repair });
    const section = async (name, inspect) => {
        try { return await inspect(); }
        catch (cause) { add('warn', name, `could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`); return undefined; }
    };
    // Filled in once Herdr's registrations are read; it still prints first.
    const versions = { level: 'ok', name: 'muxr versions', detail: '' };
    checks.push(versions);
    const managedMode = daemonMode();
    const { binary, panePack } = await section('runtime', () => runtimeChecks(add, managedMode)) ?? {};
    await section('muxr versions', () => Object.assign(versions, versionAgreement(cliVersion(), hostServiceVersion(), panePack)));
    await section('state folder', () => stateFolderCheck(add));
    // Lab-only until the release that switches to Herdr Core: nothing reads it, so a normal doctor stays quiet.
    if (env('MUXR_HERDR_CORE_CHECK') === '1' && managedMode !== 'relay') {
        await section('herdr core', () => {
            const core = herdrCoreStatus();
            add(core.state === 'ok' ? 'ok' : 'warn', 'herdr core', core.detail);
        });
    }
    await section('stale files', () => staleFileChecks(add));
    await section('services', () => serviceChecks(add, managedMode, binary));
    await section('self-host', () => selfhostChecks(add, managedMode));
    return checks;
}

async function applySafeRepairs(checks) {
    let fixed = 0;
    for (const { repair } of checks.filter((check) => check.repair?.safe)) {
        try {
            await repair.run();
            print(`  fixed  ${repair.label}`);
            fixed += 1;
        } catch (cause) {
            print(`  could not ${repair.label}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }
    return fixed;
}

export async function inspectSetup({ fix = false, ask = true } = {}) {
    let checks = await collectChecks();
    let fixed = 0;
    if (fix) {
        fixed = await applySafeRepairs(checks);
        checks = await collectChecks();
    }
    const width = Math.max(...checks.map((check) => check.name.length));
    print();
    for (const check of checks) print(`  ${{ ok: 'ok  ', warn: 'warn', fail: 'FAIL' }[check.level]}  ${check.name.padEnd(width)}  ${check.detail}`);
    const failures = checks.filter((check) => check.level === 'fail');
    print(failures.length ? `\n${failures.length} blocking problem${failures.length === 1 ? '' : 's'} above.` : '\nmuxr setup checks passed.');
    const fixable = checks.filter((check) => check.repair?.safe).length;
    const left = checks.filter((check) => check.level !== 'ok' && !check.repair?.safe).length;
    if (fixed + fixable + left > 0) {
        const counts = [[fixed, 'fixed'], [fixable, 'fixable'], [left, 'need you'], [checks.length - fixable - left, 'ok']]
            .filter(([count]) => count > 0).map((entry) => entry.join(' '));
        print(`${counts.join(', ')}.${fixable > 0 ? ' Run: muxr triage --fix' : ''}`);
    }
    // Interactive repair: offer only what failed and has a known-safe action;
    // anything else stays a printed remedy. Non-interactive runs report only.
    const repairs = failures.filter((check) => check.repair !== undefined);
    if (ask && repairs.length > 0 && process.stdin.isTTY && process.stdout.isTTY) {
        print('\nRepairs available:');
        for (const check of repairs) print(`  • ${check.repair.label}`);
        if (await askVisible(`Run ${repairs.length === 1 ? 'this repair' : `these ${repairs.length} repairs`} now? [y/N] `, { piped: true })) {
            for (const check of repairs) {
                print(`  → ${check.repair.label}`);
                try {
                    const code = await check.repair.run();
                    if (typeof code === 'number' && code !== 0) print(`  warn: repair for "${check.name}" did not finish cleanly`);
                } catch (cause) {
                    print(`  warn: repair for "${check.name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
                }
            }
            print('Repairs finished — rerun `muxr doctor` to confirm.');
        }
    }
    return failures.length ? 1 : 0;
}
