import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pairingIntentFromSelfhostFlags, parseConnection } from '../domain/dist/index.js';
import {
    askVisible,
    env,
    error,
    flagValue,
    machineIdentity,
    print,
    stateDir,
} from '../infrastructure/runtime.mjs';
import { daemonIsRunning, runDaemon, startMuxrDaemon } from '../infrastructure/daemon.mjs';
import { operatorConfigPath, planToArgs, resolveSetupPlan } from '../infrastructure/operatorConfig.mjs';
import {
    cleanupManagedIngress,
    cloudflaredAlive,
    persistOwnedServeIngress,
    readSelfhostState,
    selfhostPath,
    selfhostStateUnreadable,
    stopOwnedSelfhostRelay,
    tailscaleIngress,
    writeSelfhostState,
} from '../infrastructure/selfhost.mjs';
import {
    ensureSelfhostRelay,
    relayDiscovery,
    resolveAdvertise,
    withSelfhostRotationLock,
    writeRelayEnv,
} from '../infrastructure/selfhostRelay.mjs';
import { mintDeviceGrant } from './pairDevice.mjs';

export async function startSelfHost(args = []) {
    // `--apply-config` is one plan everywhere: the desired-state module
    // plans, applies (through this function with derived flags) and verifies.
    if (args.includes('--apply-config') && !args.includes('--from-desired-state')) {
        const { applyDesiredState } = await import('./applyDesiredState.mjs');
        return applyDesiredState(args);
    }
    let pendingIngress;
    let plan;
    try {
        // One normalized plan: precedence resolved once (flag > env > file >
        // probed/default), validated once. Downstream helpers read intent
        // from the plan-derived argv, never re-derived from raw args, so
        // apply cannot diverge from what Review showed. The operator file
        // never carries secrets. A missing file defaults; a malformed or
        // unsupported file fails here, clearly.
        plan = resolveSetupPlan({ args });
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
    // Intent flags, canonically derived: every helper below that reads
    // --port/--connection-mode/--web/--advertise/--tunnel/--tailscale-direct
    // sees the reviewed plan, even when it arrived via env or config.env.
    const intentArgs = planToArgs(plan.values);
    const effectiveArgs = [...args, ...intentArgs];
    const applyConfig = args.includes('--apply-config');
    const foreground = args.includes('--foreground');
    if (applyConfig) {
        const missing = [];
        if (plan.values.connection === undefined) missing.push('MUXR_CONNECTION (tailscale|tailscale-direct|private|lan|cloudflare|external)');
        if (plan.values.connection === 'external' && plan.values.advertiseUrl === undefined) {
            missing.push('MUXR_ADVERTISE_URL (required for MUXR_CONNECTION=external)');
        }
        if (missing.length > 0) {
            error(`--apply-config needs every decision in ${operatorConfigPath()} or flags:\n  missing: ${missing.join(', ')}`);
            return 1;
        }
        print(`  applying operator config from ${operatorConfigPath()}`);
    }
    const port = plan.values.relayPort ?? 8792;
    const relayOnly = args.includes('--relay-only');
    const managedRelay = args.includes('--managed-relay');
    const hostOnly = args.includes('--host-only');
    const dryRun = args.includes('--dry-run');
    const web = plan.values.web ?? false;
    const pair = pairingIntentFromSelfhostFlags(args);
    const noPair = args.includes('--no-pair');
    const connectionMode = plan.values.connection;
    const reconfigure = args.includes('--reconfigure');
    const yes = args.includes('--yes') || applyConfig;
    if (web && !process.stdout.isTTY && !yes) {
        error('--web requires an interactive trust confirmation or explicit --yes');
        return 1;
    }
    const webRoot = flagValue(args, '--web-root') ?? join(dirname(realpathSync(process.argv[1])), 'web');
    try {
        if (relayOnly && hostOnly) throw new Error('choose only one of --relay-only or --host-only');
        if (selfhostStateUnreadable()) {
            // Corrupt is not "not configured": reconfiguring would mint a new
            // machine identity and destroy every pairing.
            throw new Error(`${selfhostPath()} exists but is unreadable (truncated or corrupt); refusing to reconfigure over it. Move it aside when you are sure — \`mv ${selfhostPath()} ${selfhostPath()}.broken\` — then rerun`);
        }
        if (web && process.stdout.isTTY && !yes) {
            print('Web access supports 8-hour control or view-only browser grants. Secret material is WebCrypto-wrapped in IndexedDB; close shared browsers and revoke them from `muxr devices`.');
            const approved = await askVisible('Continue with browser access? [y/N] ');
            if (!approved) return 0;
        }
        if (dryRun) {
            let target = 'the self-host relay and agent host';
            if (relayOnly) target = 'the self-host relay';
            else if (hostOnly) target = 'the self-host agent host';
            print(`  would start ${target}`);
            if (!relayOnly) print('  would create a single-use encrypted mobile pairing QR');
            for (const [key, val] of Object.entries(plan.values)) {
                print(`  config: ${key}=${val} (${plan.provenance[key]})`);
            }
            return 0;
        }
        let state = readSelfhostState();
        if (hostOnly) {
            if (state === undefined) throw new Error('no self-host state yet; run `muxr self-host` first');
            await startMuxrDaemon('selfhost', args);
            print('Ready — the muxr host is connected to your relay.');
            return 0;
        }
        if (state === undefined) {
            state = { version: 1, machine: machineIdentity(undefined), relayPort: port };
        }
        const hostWasRunning = daemonIsRunning();
        const explicitAdvertise = plan.values.advertiseUrl;
        const connection = parseConnection(state);
        const sameConfiguration = connection.ok && connection.value.sameAs({ port, connectionMode, web, explicitAdvertise });
        if (!sameConfiguration && reconfigure) {
            cleanupManagedIngress(state);
            if (hostWasRunning && (await runDaemon(['stop'])) !== 0) throw new Error('could not stop the managed muxr service before reconfiguration');
            await stopOwnedSelfhostRelay();
            delete state.ingress;
        }
        state.relayPort = port;
        if (web && !existsSync(join(webRoot, 'index.html'))) throw new Error(`web client missing at ${webRoot}; install a package with the web client or pass --web-root`);
        // Missing Tailscale is fine. Broken/unsafe Tailscale status must fail
        // closed; another transport is chosen explicitly, never as a guess.
        print('  … checking network connection and ingress');
        const tailscale = tailscaleIngress(effectiveArgs);
        const advertise = sameConfiguration && connectionMode === 'cloudflare' && typeof state.relayUrl === 'string' && cloudflaredAlive(state.ingress)
            ? { url: state.relayUrl, note: 'existing Cloudflare quick tunnel', ingress: state.ingress }
            : await resolveAdvertise(effectiveArgs, port, tailscale);
        pendingIngress = advertise.ingress?.kind === 'cloudflare-quick' ? advertise.ingress : undefined;
        if (advertise.ingress?.kind === 'tailscale-serve') state = persistOwnedServeIngress(state, advertise.ingress);
        if (web && !advertise.url.startsWith('wss://')) throw new Error('--web requires HTTPS (Tailscale Serve, a named HTTPS tunnel, or --advertise wss://...)');
        const bindHost = tailscale || args.includes('--tunnel') || web || explicitAdvertise?.startsWith('wss://') ? '127.0.0.1' : '0.0.0.0';
        const webOrigin = web ? advertise.url.replace(/^wss/, 'https') : undefined;
        // Operator intent that the relay process itself consumes travels as
        // explicit env (never via ambient process env, which setup cannot
        // rely on). Persisted to relay.env below for the supervised service.
        const relayEnv = plan.values.notifyEmail === undefined ? {} : { MUXR_NOTIFY_EMAIL: plan.values.notifyEmail };
        print(`  … checking local relay port ${port}`);
        await ensureSelfhostRelay(port, web ? webRoot : undefined, bindHost, webOrigin, {
            machineId: state.machine.id,
            name: state.machine.name,
            relayUrl: advertise.url,
            mode: connectionMode,
        }, relayEnv);
        const mintPath = join(stateDir(), 'relay', 'mint-secret');
        const mintInfo = lstatSync(mintPath);
        if (!mintInfo.isFile() || mintInfo.isSymbolicLink() || (mintInfo.mode & 0o077) !== 0) {
            throw new Error(`${mintPath} must be a regular owner-only file`);
        }
        const secretRaw = JSON.parse(readFileSync(mintPath, 'utf8'));
        state.mintSecret = secretRaw;
        state.relayUrl = advertise.url;
        state.relayLocation = 'local';
        delete state.machineCredential;
        delete state.credentialExpiresAt;
        state.relayRole = managedRelay ? 'shared' : 'single-machine';
        state.connectionMode = connectionMode;
        state.webEnabled = web;
        state.webRoot = web ? webRoot : undefined;
        state.webOrigin = webOrigin;
        state.bindHost = bindHost;
        state.ingress = advertise.ingress;
        writeSelfhostState(state);
        // Persisted for the supervised service (unit EnvironmentFile), which
        // never inherits this process's env.
        writeRelayEnv({ notifyEmail: plan.values.notifyEmail });
        pendingIngress = undefined;
        print(`  ✓ self-host relay on :${port} (${advertise.note})`);
        print(`  ✓ advertise ${advertise.url}`);
        if (web) print(`  ✓ web client ${advertise.url.replace(/^ws/, 'http')}`);
        if (relayOnly) {
            if (managedRelay) {
                print('  … registering and starting the background relay service');
                if (env('MUXR_NO_SERVICE_COMMANDS') !== '1') await stopOwnedSelfhostRelay();
                try { await startMuxrDaemon('relay', args, !sameConfiguration || !hostWasRunning); }
                catch (cause) {
                    await ensureSelfhostRelay(port, web ? webRoot : undefined, bindHost, webOrigin, relayDiscovery(state), relayEnv).catch(() => undefined);
                    throw new Error(`the supervised relay service did not start; the temporary relay was restored when possible: ${cause instanceof Error ? cause.message : String(cause)}`);
                }
                delete state.machine;
                writeSelfhostState(state);
                print('Shared relay service ready. Create a machine enrollment from the muxr menu.');
            } else {
                print('Relay ready. Run `muxr self-host --host-only` on the machine holding this state.');
            }
            return 0;
        }
        if (foreground) {
            // MUXR_SERVICE_MODE=foreground: no OS service. The relay started
            // above stays up for this session; the host runs under `muxr up`.
            print('  ✓ foreground mode: no background service registered — run `muxr up` to start the host in this terminal');
            return 0;
        }
        print('  … registering and starting the background host service');
        if (env('MUXR_NO_SERVICE_COMMANDS') !== '1' && (!sameConfiguration || !hostWasRunning)) await stopOwnedSelfhostRelay();
        await startMuxrDaemon('selfhost', args, !sameConfiguration || !hostWasRunning);
        if (noPair) {
            print('Ready — existing paired devices will reconnect automatically.');
            return 0;
        }
        return await withSelfhostRotationLock(() => mintDeviceGrant(state, pair.kind, pair.authority, pair.personal));
    } catch (cause) {
        if (pendingIngress && cloudflaredAlive(pendingIngress)) process.kill(Number(pendingIngress.pid), 'SIGTERM');
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
