import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, delimiter } from 'node:path';
import { createConnection } from 'node:net';
import {
    env,
    error,
    flagValue,
    home,
    loadManifest,
    platform,
    print,
    run,
    saveManifest,
    stateDir,
    systemdArg,
    writeOwned,
    removeManaged,
    xml,
    ensurePrivateDir,
} from './setupRuntime.mjs';
import { ensureHerdrServer, herdrBin } from './herdrLifecycle.mjs';

export function daemonDefinition(mode) {
    if (mode !== undefined && mode !== 'hosted' && mode !== 'selfhost' && mode !== 'relay') throw new Error('--mode must be hosted, selfhost, or relay');
    const cli = realpathSync(process.argv[1]);
    const logs = join(stateDir(), 'logs');
    const serviceHerdr = herdrBin();
    const servicePath = [...new Set([
        ...(process.env.PATH ?? '').split(delimiter),
        dirname(process.execPath),
        ...(serviceHerdr === undefined ? [] : [dirname(serviceHerdr)]),
        join(home(), '.local', 'bin'),
        join(home(), '.local', 'share', 'mise', 'shims'),
        join(home(), '.npm-global', 'bin'),
        join(home(), '.bun', 'bin'),
        join(home(), '.volta', 'bin'),
        join(home(), '.deno', 'bin'),
        join(home(), '.cargo', 'bin'),
        join(home(), 'Library', 'pnpm'),
        join(home(), '.yarn', 'bin'),
        join(home(), '.nix-profile', 'bin'),
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
    ].filter((directory) => typeof directory === 'string' && isAbsolute(directory)))].join(delimiter);
    if (platform() === 'darwin') {
        const path = join(home(), 'Library', 'LaunchAgents', 'com.muxr.host.plist');
        const environment = [
            ['PATH', servicePath],
            ...(serviceHerdr === undefined ? [] : [['HERDR_BIN', serviceHerdr]]),
            ...(mode === undefined ? [] : [['MUXR_MODE', mode]]),
            ...(process.env.MUXR_HOME?.trim() ? [['MUXR_HOME', stateDir()]] : []),
        ];
        const modeEnv = environment.length === 0 ? '' : `\n<key>EnvironmentVariables</key><dict>${environment.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>`;
        const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.muxr.host</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(cli)}</string><string>up</string></array>${modeEnv}\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>StandardOutPath</key><string>${xml(join(logs, 'daemon.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(logs, 'daemon.log'))}</string>\n</dict></plist>\n`;
        return { path, content, mode: 0o600 };
    }
    if (platform() === 'linux') {
        const path = join(home(), '.config', 'systemd', 'user', 'muxr.service');
        const modeEnv = [
            `Environment=PATH=${systemdArg(servicePath)}`,
            ...(serviceHerdr === undefined ? [] : [`Environment=HERDR_BIN=${systemdArg(serviceHerdr)}`]),
            ...(mode === undefined ? [] : [`Environment=MUXR_MODE=${systemdArg(mode)}`]),
            ...(process.env.MUXR_HOME?.trim() ? [`Environment=MUXR_HOME=${systemdArg(stateDir())}`] : []),
        ].join('\n');
        // No After=network-online.target: it does not exist in the systemd user
        // manager and reads as ordering while being a silent no-op. The host
        // and relay retry their own connections instead.
        const content = `[Unit]\nDescription=muxr host bridge\nStartLimitIntervalSec=60\nStartLimitBurst=20\n\n[Service]\nExecStart=${systemdArg(process.execPath)} ${systemdArg(cli)} up\n${modeEnv ? `${modeEnv}\n` : ''}Restart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
        return { path, content, mode: 0o600 };
    }
    throw new Error('daemon services support Linux and macOS; use WSL on Windows');
}

const launchdRetrySignal = new Int32Array(new SharedArrayBuffer(4));

export function bootstrapMacService(domain, plist) {
    let result = run('launchctl', ['bootstrap', domain, plist]);
    for (let attempt = 0; !result.ok && attempt < 19
        && /Bootstrap failed:\s*5\b|Input\/output error/i.test(`${result.stdout}\n${result.stderr}`); attempt += 1) {
        Atomics.wait(launchdRetrySignal, 0, 0, 100);
        result = run('launchctl', ['bootstrap', domain, plist]);
    }
    return result;
}

export function serviceCommand(action) {
    if (env('MUXR_NO_SERVICE_COMMANDS') === '1') return { ok: true, stdout: 'service command skipped by test environment', stderr: '' };
    if (platform() === 'darwin') {
        const domain = `gui/${process.getuid()}`;
        const label = 'com.muxr.host';
        const service = `${domain}/${label}`;
        const plist = join(home(), 'Library', 'LaunchAgents', 'com.muxr.host.plist');
        if (action === 'reload') return { ok: true, stdout: '', stderr: '' };
        if (action === 'start' || action === 'restart') {
            const loaded = run('launchctl', ['print', service]);
            if (loaded.ok) {
                const unloaded = run('launchctl', ['bootout', service]);
                if (!unloaded.ok) return unloaded;
            }
            const bootstrapped = bootstrapMacService(domain, plist);
            return bootstrapped.ok ? run('launchctl', ['kickstart', '-k', service]) : bootstrapped;
        }
        if (action === 'stop' || action === 'unload') return run('launchctl', ['bootout', service]);
        if (action === 'status') {
            const printed = run('launchctl', ['print', service]);
            return { ...printed, ok: printed.ok && /\bstate = running\b/.test(printed.stdout) };
        }
    }
    if (action === 'reload') return run('systemctl', ['--user', 'daemon-reload']);
    if (action === 'start') return run('systemctl', ['--user', 'enable', '--now', 'muxr.service']);
    if (action === 'restart') {
        // Restart must also enable: a stop-then-restart unit is otherwise
        // active now but silently gone at the next boot.
        const enabled = run('systemctl', ['--user', 'enable', 'muxr.service']);
        if (!enabled.ok) return enabled;
        return run('systemctl', ['--user', 'restart', 'muxr.service']);
    }
    if (action === 'stop') return run('systemctl', ['--user', 'stop', 'muxr.service']);
    if (action === 'status') return run('systemctl', ['--user', 'status', 'muxr.service', '--no-pager']);
    if (action === 'unload') return run('systemctl', ['--user', 'disable', '--now', 'muxr.service']);
    return { ok: false, stdout: '', stderr: `unknown service action ${action}` };
}

export function daemonIsRunning() {
    return serviceCommand('status').ok;
}

export function readPeerBrokerAccess() {
    const accessPath = join(stateDir(), 'host', 'peer', 'cli.json');
    try {
        const info = lstatSync(accessPath);
        const access = JSON.parse(readFileSync(accessPath, 'utf8'));
        return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
            && access?.version === 1 && typeof access.socketPath === 'string' && isAbsolute(access.socketPath)
            && typeof access.capability === 'string' && /^[A-Za-z0-9_-]{40,80}$/.test(access.capability)
            ? { socketPath: access.socketPath, capability: access.capability }
            : undefined;
    } catch {
        return undefined;
    }
}

export async function waitForPeerBrokerReady(previousCapability, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const access = readPeerBrokerAccess();
        if (access !== undefined && access.capability !== previousCapability) {
            const authenticated = await new Promise((resolve) => {
                const socket = createConnection(access.socketPath);
                let input = '';
                let settled = false;
                const finish = (ready) => {
                    if (settled) return;
                    settled = true;
                    socket.destroy();
                    resolve(ready);
                };
                socket.setTimeout(500, () => finish(false));
                socket.once('connect', () => socket.write(`${JSON.stringify({
                    id: 'daemon-readiness',
                    capability: access.capability,
                    ready: true,
                })}\n`));
                socket.on('data', (chunk) => {
                    input += chunk.toString('utf8');
                    const newline = input.indexOf('\n');
                    if (newline === -1) return;
                    try {
                        const response = JSON.parse(input.slice(0, newline));
                        finish(response?.id === 'daemon-readiness' && response.ok === true && response.data?.ready === true);
                    } catch {
                        finish(false);
                    }
                });
                socket.once('error', () => finish(false));
                socket.once('close', () => finish(false));
            });
            if (authenticated) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('peer access did not become ready after the muxr service started');
}

export function daemonMode() {
    try {
        const content = readFileSync(daemonDefinition().path, 'utf8');
        if (/MUXR_MODE[\s\S]{0,80}selfhost/.test(content)) return 'selfhost';
        if (/MUXR_MODE[\s\S]{0,80}relay/.test(content)) return 'relay';
        if (/MUXR_MODE[\s\S]{0,80}hosted/.test(content)) return 'hosted';
        return undefined;
    } catch { return undefined; }
}

export function rotateMacDaemonLog() {
    if (platform() !== 'darwin') return;
    const path = join(stateDir(), 'logs', 'daemon.log');
    if (!existsSync(path) || statSync(path).size <= 5 * 1024 * 1024) return;
    const previous = `${path}.1`;
    rmSync(previous, { force: true });
    renameSync(path, previous);
}

export async function runDaemon(args = []) {
    const action = args[0] ?? 'status';
    const dryRun = args.includes('--dry-run');
    const mode = flagValue(args, '--mode');
    const force = args.includes('--force');
    const manifest = loadManifest();
    try {
        if (action === 'install') {
            const definition = daemonDefinition(mode);
            const existed = existsSync(definition.path);
            const previousContent = existed ? readFileSync(definition.path, 'utf8') : undefined;
            const wasRunning = daemonIsRunning();
            let content = definition.content;
            if (previousContent !== undefined) {
                // Preserve Environment lines this generator did not author —
                // e.g. MUXR_HOME pinned by an earlier install would otherwise
                // be silently dropped by a re-install.
                const authored = new Set([...content.matchAll(/^Environment="?(\w+)=/gm)].map((match) => match[1]));
                const foreign = (previousContent.match(/^Environment=.*$/gm) ?? [])
                    .filter((line) => !authored.has(line.match(/^Environment="?(\w+)=/)?.[1]));
                if (foreign.length > 0) content = content.replace('[Service]\n', `[Service]\n${foreign.join('\n')}\n`);
            }
            const changed = previousContent !== content;
            if (!dryRun) ensurePrivateDir(join(stateDir(), 'logs'));
            writeOwned(definition.path, content, manifest, { dryRun, force, mode: definition.mode });
            if (!dryRun) manifest.entries[definition.path].scope = 'daemon';
            saveManifest(manifest, dryRun);
            if (!dryRun) {
                const reload = serviceCommand('reload');
                if (!reload.ok) throw new Error(reload.stderr || reload.stdout || 'service reload failed');
                // Every mode needs linger: without it the service dies at
                // logout and never starts on a headless or SSH-only box.
                if (platform() === 'linux' && env('MUXR_NO_SERVICE_COMMANDS') !== '1') {
                    const username = userInfo().username;
                    const linger = run('loginctl', ['show-user', username, '-p', 'Linger', '--value']);
                    if (!linger.ok || linger.stdout.trim() !== 'yes') {
                        const enabled = run('loginctl', ['enable-linger', username]);
                        // WSL and containers have no loginctl; warn, don't fail.
                        if (!enabled.ok) print(`  warn: could not enable boot persistence (${enabled.stderr || enabled.stdout || 'loginctl unavailable'}); the service will not restart after logout`);
                    }
                }
            }
            if (!args.includes('--quiet')) {
                if (dryRun) print(`  would ${existed ? 'update' : 'install'} the muxr background service without starting it`);
                else if (!existed) print('  ✓ muxr background service installed. It was not started.');
                else if (!changed) print(`  ✓ muxr background service already installed (${wasRunning ? 'running' : 'stopped'}).`);
                else if (wasRunning) print('  ✓ muxr background-service definition updated. Restart required to apply it.');
                else print('  ✓ muxr background-service definition updated. It was not started.');
            }
            return 0;
        }
        if (action === 'uninstall') {
            const entries = Object.entries(manifest.entries).filter(([, entry]) => entry.scope === 'daemon');
            if (!dryRun) {
                const unloaded = serviceCommand('unload');
                const alreadyAbsent = entries.length === 0 && !existsSync(daemonDefinition().path);
                if (!unloaded.ok && !alreadyAbsent) throw new Error(unloaded.stderr || unloaded.stdout || 'could not stop and unload the muxr service');
                const { readSelfhostState, stopOwnedSelfhostRelay, cleanupManagedIngress } = await import('./selfhostRuntime.mjs');
                const state = readSelfhostState();
                await stopOwnedSelfhostRelay();
                cleanupManagedIngress(state);
            }
            for (const [path, entry] of entries) removeManaged(path, entry, manifest, { dryRun, force });
            saveManifest(manifest, dryRun);
            if (!dryRun) {
                const reloaded = serviceCommand('reload');
                if (!reloaded.ok) throw new Error(reloaded.stderr || reloaded.stdout || 'service reload failed');
            }
            if (!args.includes('--quiet')) print(dryRun
                ? '  would stop muxr and remove its background-service definition and owned ingress'
                : '  ✓ muxr service stopped; background-service definition and owned ingress removed');
            return 0;
        }
        if (action === 'logs') {
            if (platform() === 'darwin') {
                const path = join(stateDir(), 'logs', 'daemon.log');
                print(existsSync(path) ? readFileSync(path, 'utf8') : 'No daemon log yet.');
                return 0;
            }
            const result = run('journalctl', ['--user', '-u', 'muxr.service', '-n', '100', '--no-pager']);
            print(result.stdout || result.stderr || 'No daemon log yet.');
            return result.ok ? 0 : 1;
        }
        if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('usage: muxr daemon install|uninstall|start|stop|restart|status|logs');
        const installedMode = daemonMode();
        const serviceWasRunning = (action === 'start' || action === 'restart') && daemonIsRunning();
        const replacesService = action === 'restart'
            || action === 'start' && (platform() === 'darwin' || !serviceWasRunning);
        const previousPeerCapability = replacesService ? readPeerBrokerAccess()?.capability : undefined;
        let herdrFailure;
        if ((action === 'start' || action === 'restart') && installedMode !== 'relay') {
            try { await ensureHerdrServer(undefined, false, args.includes('--quiet')); }
            catch (cause) { herdrFailure = cause; }
        }
        if (!dryRun && (action === 'start' || action === 'restart')) rotateMacDaemonLog();
        const result = serviceCommand(action);
        if (!result.ok) {
            if (action === 'status') print('muxr service is stopped or unavailable.');
            else error(result.stderr || result.stdout || `muxr service ${action} failed`);
            return 1;
        }
        if (!dryRun && env('MUXR_NO_SERVICE_COMMANDS') !== '1'
            && (action === 'start' || action === 'restart')
            && (installedMode === 'selfhost' || installedMode === 'hosted')) {
            try { await waitForPeerBrokerReady(previousPeerCapability); }
            catch (cause) {
                error(cause instanceof Error ? cause.message : String(cause));
                return 1;
            }
        }
        if (herdrFailure !== undefined) {
            error(`  warn: muxr service ${action === 'restart' ? 'restarted' : 'started'}, but Herdr did not recover: ${herdrFailure instanceof Error ? herdrFailure.message : String(herdrFailure)}`);
            return 0;
        }
        if (!args.includes('--quiet')) {
            if (action === 'start') print('  ✓ muxr service started and enabled for login');
            else if (action === 'restart') print('  ✓ muxr services restarted');
            else if (action === 'stop') print('  ✓ muxr service stopped. It remains installed and may start at the next login.');
            else print('muxr service is running.');
        }
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function startMuxrDaemon(mode, args = [], restartRunning = true) {
    const dryRun = args.includes('--dry-run');
    const wasRunning = daemonIsRunning();
    const common = [...(dryRun ? ['--dry-run'] : []), ...(args.includes('--force') ? ['--force'] : [])];
    if ((await runDaemon(['install', '--mode', mode, '--quiet', ...common])) !== 0) throw new Error('daemon registration failed');
    if (dryRun) {
        print(`  would start muxr services in ${mode} mode`);
        return;
    }
    const running = daemonIsRunning();
    if (!running || restartRunning) {
        const action = running ? 'restart' : 'start';
        if ((await runDaemon([action, '--quiet'])) !== 0) throw new Error(`muxr host did not ${action}`);
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (serviceCommand('status').ok) {
            const needsRelay = mode === 'selfhost' || mode === 'relay';
            let relayReady = !needsRelay;
            if (needsRelay) {
                const { readSelfhostState, selfhostRelayHealthy } = await import('./selfhostRuntime.mjs');
                relayReady = await selfhostRelayHealthy(readSelfhostState());
            }
            if (relayReady) {
                const relayDetail = needsRelay ? '; relay reachable' : '';
                if (wasRunning) {
                    print(`  ✓ muxr background service ${restartRunning ? 'updated and restarted' : 'already running'} in ${mode} mode${relayDetail}`);
                } else {
                    print(`  ✓ muxr background service installed and running in ${mode} mode${relayDetail}`);
                }
                return;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('muxr host service did not become ready; run `muxr daemon logs`');
}
