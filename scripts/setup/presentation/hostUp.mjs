/** Run the user-operated host bridge. In self-host mode this process also owns the relay child. */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureHerdrServer } from '../infrastructure/herdr.mjs';
import { hostEntry, relayEntry, webClientRoot } from '../infrastructure/paths.mjs';
import { readSelfhostState, readDesiredConfig } from '../infrastructure/selfhost.mjs';

/** auto binds loopback for browser/tunnel routes, all interfaces for direct/private/LAN. */
function resolveBindHost(bindHost, connectionMode) {
    if (bindHost === '127.0.0.1' || bindHost === '0.0.0.0') return bindHost;
    return ['tailscale', 'external', 'cloudflare'].includes(connectionMode) ? '127.0.0.1' : '0.0.0.0';
}

const hostPath = hostEntry();
const relayPath = relayEntry();
const children = [];
let stopping = false;
// The host respawns in-process with bounded backoff so the relay keeps serving
// phones; once the budget is spent the whole unit exits non-zero so systemd
// takes over. A hostless unit must never stay 'active' — it would look healthy.
const HOST_RESTART_DELAYS_MS = (process.env.MUXR_HOST_RESTART_DELAYS?.trim() || '1000,2000,5000,10000,30000')
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
let hostRestarts = 0;
let hostRetry;

function startHost() {
    const child = start(hostPath, process.env, process.argv.slice(3));
    // A host that stays up for a minute earns its restart budget back.
    const stable = setTimeout(() => {
        hostRestarts = 0;
    }, 60_000);
    stable.unref();
    child.on('exit', () => clearTimeout(stable));
    return child;
}

function start(entry, env = process.env, args = []) {
    const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit', env });
    children.push(child);
    child.on('exit', (code, signal) => {
        if (stopping) return;
        process.stderr.write(`muxr ${entry === hostPath ? 'host' : 'relay'} exited (${signal ?? code ?? 1})\n`);
        const relayAlive = children.some((sibling) => sibling !== child && sibling.exitCode === null);
        const crashed = signal !== undefined || (code ?? 1) !== 0;
        if (entry === hostPath && relayAlive && crashed) {
            if (hostRestarts < HOST_RESTART_DELAYS_MS.length) {
                // A host crash must not tear down a healthy relay: respawn the
                // host while phones keep their relay.
                const delay = HOST_RESTART_DELAYS_MS[hostRestarts];
                hostRestarts += 1;
                process.stderr.write(`muxr restarting the host in ${delay}ms (attempt ${hostRestarts}/${HOST_RESTART_DELAYS_MS.length})\n`);
                hostRetry = setTimeout(() => {
                    hostRetry = undefined;
                    if (!stopping) startHost();
                }, delay);
                hostRetry.unref();
                return;
            }
            process.stderr.write('muxr host restart budget exhausted; exiting so systemd can restart the unit\n');
        }
        stopping = true;
        if (hostRetry !== undefined) clearTimeout(hostRetry);
        for (const sibling of children) if (sibling !== child && sibling.exitCode === null) sibling.kill('SIGTERM');
        process.exitCode = code ?? 1;
    });
    return child;
}

async function waitForRelay(port) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false);
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`muxr relay did not become ready on :${port}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
process.on('exit', () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
});

const mode = process.env.MUXR_MODE;
if (mode === 'selfhost' || mode === 'relay') {
    const root = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
    // Applied view: machine identity and the actual advertised endpoint.
    // Desired: the editable values a manual selfhost.json edit changes — so a
    // restart honours them instead of a stale persisted webRoot/bindHost.
    const state = readSelfhostState();
    if (state === undefined) throw new Error('self-host relay state is missing or unreadable');
    const desired = readDesiredConfig() ?? {};
    if (mode === 'relay' || state.relayLocation !== 'remote') {
        const port = Number(desired.relayPort ?? state.relayPort);
        if (!Number.isInteger(port)) throw new Error('self-host relay state has no valid port');
        const connectionMode = desired.connectionMode ?? state.connectionMode;
        // webRoot is derived from desired webEnabled and the current package,
        // never inherited: false removes static serving and its web origin.
        const webEnabled = desired.webEnabled === true;
        const webRoot = webEnabled ? webClientRoot() : undefined;
        if (webEnabled && webRoot === undefined) process.stderr.write('muxr: web is enabled but the packaged web client is missing; serving without it\n');
        const webOrigin = webRoot !== undefined && typeof state.relayUrl === 'string' ? state.relayUrl.replace(/^wss/, 'https') : undefined;
        const relay = start(relayPath, {
            ...process.env,
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_MDNS: state.machine?.id && state.relayUrl ? '1' : '0',
            ...(state.machine?.id ? { MUXR_RELAY_MDNS_MACHINE: state.machine.id } : {}),
            ...(state.machine?.name ? { MUXR_RELAY_MDNS_NAME: `muxr ${state.machine.name}` } : {}),
            ...(state.relayUrl ? { MUXR_RELAY_MDNS_RELAY: state.relayUrl } : {}),
            ...(connectionMode ? { MUXR_RELAY_MDNS_MODE: connectionMode } : {}),
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_HOST: resolveBindHost(desired.bindHost ?? 'auto', connectionMode),
            MUXR_RELAY_DATA_DIR: join(root, 'relay'),
            ...(webRoot !== undefined ? { MUXR_WEB_ROOT: webRoot } : {}),
            ...(webOrigin !== undefined ? { MUXR_ALLOWED_ORIGINS: webOrigin } : {}),
        });
        try { await waitForRelay(port); }
        catch (cause) {
            stopping = true;
            relay.kill('SIGTERM');
            throw cause;
        }
    }
}

if (mode !== 'relay') {
    // The host needs herdr, and herdr's own boot ordering is not ours to rely
    // on: repair a stale unit path and start the server first. Failure here
    // must not take the relay down — the host survives a dead herdr itself.
    try { await ensureHerdrServer(); }
    catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
    startHost();
}

function stop(signal) {
    if (stopping) return;
    stopping = true;
    if (hostRetry !== undefined) clearTimeout(hostRetry);
    for (const child of children) if (child.exitCode === null) child.kill(signal);
    setTimeout(() => {
        for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
        process.exit(0);
    }, 2000).unref();
}
