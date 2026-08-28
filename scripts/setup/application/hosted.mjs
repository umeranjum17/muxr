import { createHash, randomBytes } from 'node:crypto';
import {
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
    HERDR_INSTALL_HINT,
    MIN_HERDR,
    api,
    askVisible,
    atomicWrite,
    authPath,
    base64,
    createDeviceGrant,
    deriveV2Key,
    env,
    error,
    executable,
    hash,
    home,
    loadManifest,
    machineIdentity,
    nacl,
    newV2ReplayTracker,
    openV2,
    platform,
    print,
    printTerminalQr,
    publicRelayUrl,
    run,
    stateDir,
    validMachineCrypto,
} from '../infrastructure/runtime.mjs';
import { parseHostedAuth, pairingIntentFromHostedFlags } from '../domain/dist/index.js';
import {
    detectedLifecycleTargets,
    ensureBundledPlugins,
    ensureHerdr,
    ensureHerdrServer,
    herdrBin,
    herdrServerIsReady,
    herdrServiceUnitPaths,
    parseIntegrationStatus,
    parseVersion,
    runIntegrations,
    staleUnitPaths,
    versionIsCompatible,
} from '../infrastructure/herdr.mjs';
import {
    daemonDefinition,
    daemonIsRunning,
    daemonMode,
    runDaemon,
    serviceCommand,
    startMuxrDaemon,
} from '../infrastructure/daemon.mjs';
import {
    advertisedRelayHealthy,
    cloudflaredAlive,
    readSelfhostState,
    selfhostControlBase,
    selfhostPath,
    selfhostRelayHealthy,
    selfhostStateUnreadable,
} from '../infrastructure/selfhost.mjs';
import {
    ensureSelfhostRelay,
    hasPendingRemoteConnect,
    remoteHostOnline,
    relayDiscovery,
} from './selfHost.mjs';

const PACKAGED_CONTROL_URL = '__MUXR_PACKAGED_CONTROL_URL__';

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
export async function runFullUninstall(args = []) {
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

export function controlUrl() {
    return env('MUXR_CONTROL_URL')
        || env('MUXR_PUBLIC_BASE_URL')
        || (PACKAGED_CONTROL_URL.startsWith('https://') ? PACKAGED_CONTROL_URL : undefined);
}

export function cliVersion() {
    for (const path of [join(dirname(realpathSync(process.argv[1])), 'package.json'), join(process.cwd(), 'package.json')]) {
        try {
            const version = JSON.parse(readFileSync(path, 'utf8')).version;
            if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) return version;
        } catch {}
    }
    return 'unknown';
}

export function loadAuthState() {
    try {
        const info = lstatSync(authPath());
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
            throw new Error(`${authPath()} must be a regular owner-only file`);
        }
        const parsed = JSON.parse(readFileSync(authPath(), 'utf8'));
        if (parsed.version !== 1) throw new Error(`${authPath()} has an unsupported schema`);
        return parsed;
    } catch (cause) {
        if (cause?.code === 'ENOENT') return undefined;
        throw cause;
    }
}

export function maybeOpenVerification(url, headless) {
    if (headless || process.env.SSH_CONNECTION || process.env.TERMUX_VERSION || !process.stdout.isTTY) return;
    const opener = platform() === 'darwin' ? 'open' : 'xdg-open';
    if (!executable(opener)) return;
    const result = run(opener, [url]);
    if (!result.ok) print('  warn: could not open the browser; use the URL below');
}

export async function runHostedLogin(args = []) {
    if (process.env.MUXR_SKIP_HOSTED_AUTH === '1') {
        print('  Hosted login skipped by explicit test/development override.');
        return 0;
    }
    const base = controlUrl();
    if (!base) throw new Error('MUXR_CONTROL_URL (or MUXR_PUBLIC_BASE_URL) is required for hosted login');
    if (!/^https:\/\//.test(base) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(base)) {
        throw new Error('hosted control URL must use HTTPS (HTTP is allowed only on loopback)');
    }
    const current = loadAuthState();
    const machine = machineIdentity(current);
    let pending = current?.machine?.id === machine.id ? current?.pending : undefined;
    if (!pending || pending.controlUrl !== base || Date.parse(pending.expiresAt) <= Date.now()) {
        const started = await api(base, '/v1/device-authorizations', {
            method: 'POST',
            body: JSON.stringify({
                machine_slug: machine.id,
                machine_name: machine.name,
                machine_public_key: machine.publicKey,
                platform: `${platform()}-${process.arch}`,
                cli_version: cliVersion(),
            }),
        });
        if (!started.response.ok || typeof started.body.device_code !== 'string') {
            throw new Error(started.body.error || `device authorization failed (${started.response.status})`);
        }
        pending = {
            controlUrl: base,
            deviceCode: started.body.device_code,
            userCode: started.body.user_code,
            verificationUri: started.body.verification_uri,
            interval: started.body.interval,
            expiresAt: new Date(Date.now() + started.body.expires_in * 1000).toISOString(),
        };
        ensurePrivateDir(stateDir());
        atomicWrite(authPath(), `${JSON.stringify({ version: 1, machine, pending }, null, 2)}\n`);
    }
    print(`  Open: ${pending.verificationUri}`);
    print(`  Code: ${pending.userCode}`);
    print('  Confirm the same code and machine details before approving.');
    maybeOpenVerification(pending.verificationUri, args.includes('--headless'));

    let interval = Number(pending.interval) || 5;
    let entitlementNoticeShown = false;
    while (Date.parse(pending.expiresAt) > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        const polled = await api(base, '/v1/device-authorizations/token', {
            method: 'POST',
            body: JSON.stringify({ device_code: pending.deviceCode }),
        });
        if (polled.response.ok && typeof polled.body.access_token === 'string') {
            const auth = {
                version: 1,
                controlUrl: base,
                relayUrl: polled.body.relay_url,
                credential: polled.body.access_token,
                credentialExpiresAt: new Date(Date.now() + polled.body.expires_in * 1000).toISOString(),
                account: polled.body.account,
                machine,
            };
            atomicWrite(authPath(), `${JSON.stringify(auth, null, 2)}\n`);
            print(`  ✓ signed in as ${auth.account.email}`);
            return 0;
        }
        if (polled.body.error === 'authorization_pending') continue;
        if (polled.body.error === 'entitlement_pending') {
            if (!entitlementNoticeShown) {
                entitlementNoticeShown = true;
                print('  Payment received — activating…');
                print(`  Billing and activation: ${base}/account`);
                maybeOpenVerification(`${base}/account`, args.includes('--headless'));
            }
            continue;
        }
        if (polled.body.error === 'slow_down') {
            interval = Number(polled.body.interval) || interval + 5;
            continue;
        }
        if (polled.body.error === 'access_denied') {
            atomicWrite(authPath(), `${JSON.stringify({ version: 1, machine }, null, 2)}\n`);
            throw new Error('device authorization was denied');
        }
        if (polled.body.error === 'expired_token' || polled.body.error === 'invalid_grant') {
            atomicWrite(authPath(), `${JSON.stringify({ version: 1, machine }, null, 2)}\n`);
            break;
        }
        throw new Error(polled.body.error || `device authorization poll failed (${polled.response.status})`);
    }
    throw new Error('device authorization expired; rerun the command to start a new session');
}

export async function runSetup(args = []) {
    const dryRun = args.includes('--dry-run');
    print(`muxr setup${dryRun ? ' (dry run)' : ''}:`);
    try {
        const binary = await ensureHerdr({
            dryRun,
            noInstall: args.includes('--no-install-herdr'),
            installRequested: args.includes('--install-herdr'),
        });
        if (binary) {
            await ensureHerdrServer(binary, dryRun);
            await ensureBundledPlugins(binary, dryRun);
            const integrationArgs = ['sync', ...(dryRun ? ['--dry-run'] : []), ...(args.includes('--force') ? ['--force'] : [])];
            if (args.includes('--all')) integrationArgs.push('--all');
            if ((await runIntegrations(integrationArgs)) !== 0) throw new Error('integration sync failed');
        }
        if (dryRun) print('  would start/resume hosted device authorization and single-use QR pairing');
        else if ((await runHostedLogin(args)) !== 0) throw new Error('hosted login failed');
        // Bring the host online before showing a device QR. The old order let
        // the phone claim a grant and begin connecting to a host that did not
        // exist yet on a clean machine.
        await startMuxrDaemon('hosted', args);
        if (!dryRun && process.env.MUXR_SKIP_HOSTED_AUTH !== '1' && (await runAccount('pair')) !== 0) {
            throw new Error('secure device pairing failed');
        }
        print('  Live Voice is optional; configure it from the muxr Voice plugin pane.');
        print('Ready — open muxr.');
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runAccount(command, args = []) {
    try {
        if (command === 'login') {
            const code = await runHostedLogin(args);
            if (code === 0) {
                const definition = daemonDefinition();
                if (existsSync(definition.path)) {
                    const restarted = serviceCommand('restart');
                    if (!restarted.ok) print(`  warn: login succeeded, but the daemon must be restarted manually (${restarted.stderr || restarted.stdout})`);
                }
            }
            return code;
        }
        const auth = loadAuthState();
        if (!auth?.credential || !auth?.controlUrl) {
            if (command === 'logout') {
                print('Already signed out.');
                return 0;
            }
            error('Not signed in — run `muxr login`.');
            return 1;
        }
        if (command === 'whoami') {
            const result = await api(auth.controlUrl, '/v1/session', {
                headers: { authorization: `Bearer ${auth.credential}` },
            });
            if (!result.response.ok) throw new Error(result.body.error || 'hosted session is no longer valid');
            print(`${result.body.account.email} — ${result.body.credential.kind}`);
            return 0;
        }
        if (command === 'logout') {
            await api(auth.controlUrl, '/v1/session', {
                method: 'DELETE',
                headers: { authorization: `Bearer ${auth.credential}` },
            });
            atomicWrite(authPath(), `${JSON.stringify({ version: 1, machine: auth.machine }, null, 2)}\n`);
            print('Signed out. Local machine keys were retained for an explicit re-login or reset.');
            return 0;
        }
        if (command === 'pair') {
            const pair = pairingIntentFromHostedFlags(args);
            if (!auth.machine?.crypto) throw new Error('machine keys are missing; run `muxr login` to register a new machine identity');
            const controlClaim = randomBytes(32).toString('base64url');
            const controlClaimHash = createHash('sha256').update(controlClaim).digest('base64url');
            const pairSecret = randomBytes(32).toString('base64url');
            const result = await api(auth.controlUrl, '/v1/pair-sessions', {
                method: 'POST',
                headers: { authorization: `Bearer ${auth.credential}` },
                body: JSON.stringify({ control_claim_hash: controlClaimHash }),
            });
            if (!result.response.ok || typeof result.body.pair_id !== 'string') {
                throw new Error(result.body.error || `pair request failed (${result.response.status})`);
            }
            const fragment = new URLSearchParams({
                v: '2',
                id: result.body.pair_id,
                claim: controlClaim,
                pair: pairSecret,
                machine: auth.machine.id,
                name: auth.machine.name,
                machinePk: auth.machine.crypto.signingPublicKey,
                generation: String(auth.machine.crypto.keyVersion),
                authority: pair.authority,
            });
            const pairUrl = `${result.body.verification_uri}#${fragment}`;
            print(`Open: ${pairUrl}`);
            if (process.stdout.isTTY) await printTerminalQr(pairUrl);
            print('Waiting for the device to claim this single-use pairing session…');
            const expiresAt = Date.now() + Number(result.body.expires_in ?? 300) * 1000;
            while (Date.now() < expiresAt) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                const polled = await api(auth.controlUrl, `/v1/pair-sessions/${encodeURIComponent(result.body.pair_id)}`, {
                    headers: { authorization: `Bearer ${auth.credential}` },
                });
                if (!polled.response.ok) throw new Error(polled.body.error || 'pair polling failed');
                if (polled.body.state === 'pending') continue;
                if (polled.body.state === 'expired') throw new Error('pairing session expired');
                const device = polled.body.device;
                if (polled.body.state !== 'claimed' || typeof device?.id !== 'string' || typeof device.public_key !== 'string') {
                    throw new Error('pairing session returned invalid device metadata');
                }
                const mailbox = polled.body.mailbox;
                if (typeof mailbox !== 'string') throw new Error('pairing mailbox is unavailable');
                const plaintext = openV2(mailbox, deriveV2Key(pairSecret, 'client->host'), {
                    machineId: auth.machine.id,
                    senderId: device.public_key,
                    recipientId: auth.machine.id,
                    channel: 'pairing',
                    streamId: result.body.pair_id,
                    keyVersion: auth.machine.crypto.keyVersion,
                }, newV2ReplayTracker());
                const request = JSON.parse(plaintext);
                if (request.devicePublicKey !== device.public_key || request.machineSigningPublicKey !== auth.machine.crypto.signingPublicKey) {
                    throw new Error('pairing mailbox substitution rejected');
                }
                const ingressKey = base64(nacl.randomBytes(32));
                const expires = pair.grantExpiresAt();
                const grant = createDeviceGrant({
                    machineId: auth.machine.id,
                    machineSigningSecretKey: auth.machine.crypto.signingSecretKey,
                    machineKey: { publicKey: auth.machine.crypto.boxPublicKey, secretKey: auth.machine.crypto.boxSecretKey },
                    deviceId: device.id,
                    devicePublicKey: device.public_key,
                    dataKey: auth.machine.crypto.dataKey,
                    ingressKey,
                    keyVersion: auth.machine.crypto.keyVersion,
                    expiresAt: expires,
                    authority: pair.authority,
                });
                const uploaded = await api(auth.controlUrl, `/v1/pair-sessions/${encodeURIComponent(result.body.pair_id)}/grant`, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${auth.credential}` },
                    body: JSON.stringify({ grant: JSON.stringify(grant) }),
                });
                if (!uploaded.response.ok) throw new Error(uploaded.body.error || 'grant upload failed');
                auth.machine.crypto.devices = [
                    ...auth.machine.crypto.devices.filter((entry) => entry.deviceId !== device.id),
                    ...pair.deviceRecord({
                        deviceId: device.id,
                        devicePublicKey: device.public_key,
                        ingressKey,
                        expiresAt: expires,
                    }),
                ];
                atomicWrite(authPath(), `${JSON.stringify(auth, null, 2)}\n`);
                const definition = daemonDefinition();
                if (existsSync(definition.path)) {
                    const restarted = serviceCommand('restart');
                    if (!restarted.ok) print(`  warn: paired, but restart the daemon manually (${restarted.stderr || restarted.stdout})`);
                }
                print(`  ✓ paired ${device.name || 'device'}`);
                return 0;
            }
            throw new Error('pairing session expired');
        }
        throw new Error(`unknown account command: ${command}`);
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
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

function runtimeKind(managedMode) {
    return managedMode === 'relay' ? 'relay' : 'host';
}

function managedSetupReport(states, drifted) {
    if (states.length === 0) return { level: 'warn', detail: 'not installed — run `muxr setup`' };
    if (drifted.length > 0) return { level: 'fail', detail: `${drifted.join(', ')} — run \`muxr integrations sync --force\`` };
    return { level: 'ok', detail: `${states.length} entries current` };
}

export async function runDoctor() {
    const checks = [];
    // repair: { label, run } — offered interactively when the check fails.
    const add = (level, name, detail, repair) => checks.push({ level, name, detail, repair });
    const major = Number(process.versions.node.split('.')[0]);
    add(major >= 22 ? 'ok' : 'fail', 'node', `v${process.versions.node}${major >= 22 ? '' : ' — needs >= 22'}`);
    const cliDir = dirname(realpathSync(process.argv[1]));
    const managedMode = daemonMode();
    const kind = runtimeKind(managedMode);
    const runtime = kind === 'relay'
        ? existsSync(join(cliDir, 'relay.js')) || existsSync(join(process.cwd(), 'apps', 'relay', 'dist', 'main.js'))
        : existsSync(join(cliDir, 'host.js')) || existsSync(join(process.cwd(), 'apps', 'host', 'dist', 'main.js'));
    add(runtime ? 'ok' : 'fail', kind, runtime
        ? `${kind} runtime present`
        : `missing ${kind} runtime; rebuild or reinstall muxr`);
    if (existsSync(authPath()) || managedMode === 'hosted') {
        try {
            const parsed = parseHostedAuth(loadAuthState());
            if (!parsed.ok) {
                add('fail', 'hosted auth', '~/.muxr/auth.json is incomplete — back it up before moving it aside, then run `muxr login`');
            } else {
                const report = parsed.value.report();
                add(report.level, 'hosted auth', report.detail);
            }
        } catch (cause) {
            add('fail', 'hosted auth', `${cause instanceof Error ? cause.message : String(cause)} — back up ~/.muxr/auth.json before moving it aside, then run \`muxr login\``);
        }
    }
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
            : 'not running — start it with `herdr server`',
            serverReady ? undefined : { label: 'start the herdr server', run: async () => { await ensureHerdrServer(binary); } });
        const integrations = run(binary, ['integration', 'status']);
        if (integrations.ok) {
            const statuses = parseIntegrationStatus(integrations.stdout);
            const detected = detectedLifecycleTargets(statuses).map(([id, status]) => `${id}:${status}`);
            const needsSync = detected.some((status) => !status.endsWith(':current'));
            add(needsSync ? 'warn' : 'ok', 'integrations', needsSync
                ? `${detected.join(', ')} — run \`muxr integrations sync\``
                : detected.join(', ') || 'no supported agent CLI detected');
        } else {
            add('warn', 'integrations', `${integrations.stderr || 'status unavailable'} — run \`muxr integrations sync\``);
        }
    }
    const manifest = loadManifest();
    const states = Object.entries(manifest.entries).map(([path, entry]) => `${path.startsWith(`${home()}/`) ? `~/${path.slice(home().length + 1)}` : basename(path)}:${entryStatus(path, entry)}`);
    const drifted = states.filter((state) => state.endsWith(':drifted') || state.endsWith(':missing'));
    const setup = managedSetupReport(states, drifted);
    add(setup.level, 'managed setup', setup.detail,
        drifted.length ? { label: 're-sync managed integration files', run: () => runIntegrations(['sync', '--force']) } : undefined);
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
        const enabled = run('systemctl', ['--user', 'is-enabled', 'muxr.service']);
        const isEnabled = enabled.stdout === 'enabled' || enabled.stdout === 'enabled-runtime';
        add(isEnabled ? 'ok' : 'fail', 'service enabled', isEnabled
            ? 'muxr.service starts at login'
            : `muxr.service is ${enabled.stdout || 'not enabled'} — it will not survive a reboot; enable it with \`muxr daemon start\``,
            isEnabled ? undefined : { label: 'enable and start the muxr service', run: () => runDaemon(['start']) });
    }
    if (platform() === 'darwin' && existsSync(muxrServicePath) && env('MUXR_NO_SERVICE_COMMANDS') !== '1') {
        const definition = readFileSync(muxrServicePath, 'utf8');
        const loaded = serviceCommand('status');
        const startsAtLogin = /<key>RunAtLoad<\/key><true\/>/.test(definition);
        add(loaded.ok && startsAtLogin ? 'ok' : 'fail', 'service loaded', loaded.ok && startsAtLogin
            ? 'com.muxr.host is loaded and starts at login'
            : `${loaded.ok ? 'service is loaded but RunAtLoad is off' : 'com.muxr.host is not loaded'} — run \`muxr daemon start\``,
            loaded.ok && startsAtLogin ? undefined : { label: 'load the muxr service for login', run: () => runDaemon(['start']) });
    }
    let selfhost = readSelfhostState();
    if (selfhostStateUnreadable()) {
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
    const relayReady = await selfhostRelayHealthy(selfhost);
    const relayDetail = selfhost?.relayLocation === 'remote'
        ? publicRelayUrl(selfhost.relayUrl) ?? 'remote relay'
        : `:${selfhost?.relayPort}`;
    let relayLevel = 'warn';
    let relayDetailText = 'not configured — run muxr setup';
    if (selfhost !== undefined && relayReady) {
        relayLevel = 'ok';
        relayDetailText = `reachable at ${relayDetail}`;
    } else if (selfhost !== undefined) {
        relayLevel = 'fail';
        relayDetailText = `configured at ${relayDetail}, not reachable — restart it with \`muxr daemon restart\``;
    }
    const relayRepair = selfhost !== undefined && !relayReady && selfhost.relayLocation !== 'remote'
        ? { label: 'restart the self-host relay', run: async () => {
            const definition = daemonDefinition();
            if (existsSync(definition.path)) {
                if ((await runDaemon(['restart'])) !== 0) throw new Error('muxr daemon restart failed');
            } else {
                await ensureSelfhostRelay(selfhost.relayPort, selfhost.webRoot, selfhost.bindHost, selfhost.webOrigin);
            }
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
        if (ingressReady) {
            connectionDetail = `${selfhost.connectionMode ?? 'self-host'} · ${publicRelayUrl(selfhost.relayUrl) ?? `local port ${selfhost.relayPort}`}`;
        } else if (selfhost.connectionMode === 'cloudflare') {
            connectionDetail = 'Cloudflare tunnel is not running; run `muxr` to restore it and pair the new endpoint';
        } else {
            connectionDetail = `advertised relay ${publicRelayUrl(selfhost.relayUrl) ?? `on local port ${selfhost.relayPort}`} is not reachable — restart with \`muxr daemon restart\` or reconfigure with \`muxr\``;
        }
        add(ingressReady ? 'ok' : 'fail', 'connection', connectionDetail);
        const hostRunning = daemonIsRunning();
        const hostAuthenticated = selfhost.relayLocation !== 'remote' || await remoteHostOnline(selfhost);
        const serviceName = managedMode === 'relay' ? 'relay service' : 'host service';
        let hostDetail = 'running but not authenticated with the shared relay — restart it with `muxr daemon restart`';
        if (!hostRunning) hostDetail = 'not running — start it with `muxr daemon start`';
        else if (hostAuthenticated) hostDetail = 'running and authenticated';
        add(hostRunning && hostAuthenticated ? 'ok' : 'fail', serviceName, hostDetail,
            !hostRunning ? { label: 'start and enable the muxr service', run: () => runDaemon(['start']) } : undefined);
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
    if (managedMode !== 'relay' && (selfhost !== undefined || existsSync(authPath()))) {
        const ready = peerAgentAccessReady();
        add(ready ? 'ok' : 'fail', 'peer agent access', ready
            ? 'ready for `muxr peers`'
            : 'not ready — run `muxr daemon restart`',
        ready ? undefined : { label: 'restart muxr to restore local peer access', run: () => runDaemon(['restart']) });
    }
    if (hasPendingRemoteConnect()) add('fail', 'pending enrollment', 'run `muxr` and choose Resume remote connection');
    const width = Math.max(...checks.map((check) => check.name.length));
    print();
    for (const check of checks) print(`  ${{ ok: 'ok  ', warn: 'warn', fail: 'FAIL' }[check.level]}  ${check.name.padEnd(width)}  ${check.detail}`);
    const failures = checks.filter((check) => check.level === 'fail');
    print(failures.length ? `\n${failures.length} blocking problem${failures.length === 1 ? '' : 's'} above.` : '\nmuxr setup checks passed.');
    // Interactive repair: offer only what failed and has a known-safe action;
    // anything else stays a printed remedy. Non-interactive runs report only.
    const repairs = failures.filter((check) => check.repair !== undefined);
    if (repairs.length > 0 && process.stdin.isTTY && process.stdout.isTTY) {
        print('\nRepairs available:');
        for (const check of repairs) print(`  • ${check.repair.label}`);
        if (await askVisible(`Run ${repairs.length === 1 ? 'this repair' : `these ${repairs.length} repairs`} now? [y/N] `)) {
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
