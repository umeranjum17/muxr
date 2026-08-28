/** Run the user-operated host bridge. In self-host mode this process also owns the relay child. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHerdrServer } from './herdrLifecycle.mjs';

const packagedHost = fileURLToPath(new URL('./host.js', import.meta.url));
const hostEntry = existsSync(packagedHost)
    ? packagedHost
    : fileURLToPath(new URL('../apps/host/dist/main.js', import.meta.url));
const packagedRelay = fileURLToPath(new URL('./relay.js', import.meta.url));
const relayEntry = existsSync(packagedRelay)
    ? packagedRelay
    : fileURLToPath(new URL('../apps/relay/dist/main.js', import.meta.url));
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
    const child = start(hostEntry, process.env, process.argv.slice(3));
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
        process.stderr.write(`muxr ${entry === hostEntry ? 'host' : 'relay'} exited (${signal ?? code ?? 1})\n`);
        const relayAlive = children.some((sibling) => sibling !== child && sibling.exitCode === null);
        const crashed = signal !== undefined || (code ?? 1) !== 0;
        if (entry === hostEntry && relayAlive && crashed) {
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
        const ready = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok).catch(() => false);
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
    const state = JSON.parse(readFileSync(join(root, 'selfhost.json'), 'utf8'));
    if (mode === 'relay' || state.relayLocation !== 'remote') {
        const port = Number(state.relayPort);
        if (!Number.isInteger(port)) throw new Error('self-host relay state has no valid port');
        const relay = start(relayEntry, {
            ...process.env,
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_MDNS: state.machine?.id && state.relayUrl ? '1' : '0',
            ...(state.machine?.id ? { MUXR_RELAY_MDNS_MACHINE: state.machine.id } : {}),
            ...(state.machine?.name ? { MUXR_RELAY_MDNS_NAME: `muxr ${state.machine.name}` } : {}),
            ...(state.relayUrl ? { MUXR_RELAY_MDNS_RELAY: state.relayUrl } : {}),
            ...(state.connectionMode ? { MUXR_RELAY_MDNS_MODE: state.connectionMode } : {}),
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_HOST: state.bindHost || '0.0.0.0',
            MUXR_RELAY_DATA_DIR: join(root, 'relay'),
            ...(state.webRoot ? { MUXR_WEB_ROOT: state.webRoot } : {}),
            ...(state.webOrigin ? { MUXR_ALLOWED_ORIGINS: state.webOrigin } : {}),
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
