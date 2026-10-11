/**
 * The muxr runtime the desktop app supervises: the repo's own relay and host,
 * started as child processes exactly as `scripts/setup/presentation/up.mjs`
 * starts them for development. The app owns no host logic; it writes the same
 * self-host state a `muxr setup` writes and then starts the host beside it.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { machineIdentity } from '../../../scripts/setup/infrastructure/runtime.mjs';
import { waitForRelay } from '../../../scripts/diagnostics/application/waitForRelay.mjs';

const CLI_RUNNING_MESSAGE = 'muxr is already running on this computer from the command-line install. Pair from there with: muxr pair';

export class RelayOwnedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RelayOwnedError';
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lanIpv4Addresses() {
    const out = [];
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.internal || entry.family !== 'IPv4') continue;
            out.push(entry.address);
        }
    }
    return out;
}

/**
 * Start the relay and host for `home`, then wait until the host is online.
 * Emits `status` events: 'starting', 'online', 'error'.
 */
export class MuxrRuntime extends EventEmitter {
    #home;
    #node;
    #relayEntry;
    #hostEntry;
    #port;
    #children = [];
    #stopping = false;
    #hostReady;

    constructor({ home, node, relayEntry, hostEntry, port }) {
        super();
        this.#home = home;
        this.#node = node;
        this.#relayEntry = relayEntry;
        this.#hostEntry = hostEntry;
        this.#port = port;
    }

    get home() { return this.#home; }
    get pairSocketPath() { return join(this.#home, 'host', 'pair.sock'); }

    #spawn(entry, env, label) {
        const child = spawn(this.#node, [entry], {
            env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.#children.push(child);
        child.stdout?.on('data', (chunk) => this.emit('log', label, chunk.toString()));
        child.stderr?.on('data', (chunk) => this.emit('log', label, chunk.toString()));
        child.on('exit', (code, signal) => {
            if (this.#stopping) return;
            this.emit('status', { phase: 'error', message: `${label} exited (${signal ?? code ?? 1})` });
        });
        return child;
    }

    #spawnRelay(port, state) {
        const machine = state?.machine;
        return this.#spawn(this.#relayEntry, {
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_MDNS: machine?.id && state?.relayUrl ? '1' : '0',
            ...(machine?.id ? { MUXR_RELAY_MDNS_MACHINE: machine.id } : {}),
            ...(machine?.name ? { MUXR_RELAY_MDNS_NAME: `muxr ${machine.name}` } : {}),
            ...(state?.relayUrl ? { MUXR_RELAY_MDNS_RELAY: state.relayUrl } : {}),
            ...(state?.connectionMode ? { MUXR_RELAY_MDNS_MODE: state.connectionMode } : {}),
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_HOST: state?.bindHost || '0.0.0.0',
            MUXR_RELAY_DATA_DIR: join(this.#home, 'relay'),
            ...(state?.webRoot ? { MUXR_WEB_ROOT: state.webRoot } : {}),
            ...(state?.webOrigin ? { MUXR_ALLOWED_ORIGINS: state.webOrigin } : {}),
        }, 'relay');
    }

    async #awaitRelay(relay) {
        let output = '';
        const collect = (chunk) => { output += chunk.toString(); };
        relay.stdout?.on('data', collect);
        relay.stderr?.on('data', collect);
        try {
            return await waitForRelay(relay);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (output.includes('another relay already owns')) {
                this.emit('status', { phase: 'already-running', message: CLI_RUNNING_MESSAGE });
                throw new RelayOwnedError(output.trim());
            }
            this.emit('status', { phase: 'error', message });
            throw error;
        }
    }

    async start() {
        this.emit('status', { phase: 'starting', message: 'Starting muxr on this computer' });
        mkdirSync(this.#home, { recursive: true, mode: 0o700 });
        const relayDataDir = join(this.#home, 'relay');

        // A self-host state written by the CLI is authoritative: the app runs the
        // host against it and never rewrites it, so a remote relay or a shared
        // connection setup survives launching the desktop app.
        const statePath = join(this.#home, 'selfhost.json');
        const existing = existsSync(statePath)
            ? JSON.parse(readFileSync(statePath, 'utf8'))
            : undefined;
        if (existing !== undefined && (!existing.machine?.id || !existing.machine?.crypto)) {
            throw new Error('desktop app: self-host state is invalid; refusing to replace its pairing identity');
        }

        if (existing === undefined) {
            // Same self-host state a `muxr setup` writes: this computer's pairing
            // identity, the relay it owns, and the relay owner's secret.
            const boundPort = await this.#awaitRelay(this.#spawnRelay(this.#port));
            const lanIp = lanIpv4Addresses()[0];
            const advertised = process.env.MUXR_RELAY_URL?.trim()
                || (lanIp === undefined ? `ws://127.0.0.1:${boundPort}` : `ws://${lanIp}:${boundPort}`);
            const state = {
                version: 1,
                machine: machineIdentity(undefined),
                relayRole: 'single-machine',
                connectionMode: 'lan',
                relayPort: boundPort,
                relayUrl: advertised,
                relayLocation: 'local',
                mintSecret: JSON.parse(readFileSync(join(relayDataDir, 'mint-secret'), 'utf8')),
            };
            writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
            this.emit('log', 'runtime', `relay on :${boundPort}, advertised ${advertised}\n`);
        } else if (existing.relayLocation !== 'remote') {
            await this.#awaitRelay(this.#spawnRelay(existing.relayPort, existing));
            this.emit('log', 'runtime', `using the existing self-host state at ${statePath}\n`);
        } else {
            this.emit('log', 'runtime', `using the existing self-host state at ${statePath}\n`);
        }

        const host = this.#spawn(this.#hostEntry, {
            MUXR_MODE: 'selfhost',
            MUXR_HOME: this.#home,
            MUXR_DATA_DIR: join(this.#home, 'host'),
        }, 'host');

        this.#hostReady = this.#waitForHost(host);
        await this.#hostReady;
        this.emit('status', { phase: 'online' });
    }

    async #waitForHost(host) {
        const deadline = Date.now() + 20_000;
        let out = '';
        host.stdout?.on('data', (chunk) => { out += chunk.toString(); });
        while (Date.now() < deadline) {
            if (host.exitCode !== null) throw new Error('the muxr host exited before it came online');
            if (out.includes('link relay: online') && existsSync(this.pairSocketPath)) return;
            await sleep(100);
        }
        throw new Error('the muxr host did not come online');
    }

    stop() {
        this.#stopping = true;
        const children = this.#children;
        this.#children = [];
        const pending = children.filter((child) => child.exitCode === null && child.signalCode === null);
        if (pending.length === 0) return Promise.resolve();
        return new Promise((resolve) => {
            let left = pending.length;
            let timer;
            const settle = () => {
                left -= 1;
                if (left > 0) return;
                clearTimeout(timer);
                resolve();
            };
            timer = setTimeout(() => {
                for (const child of pending) {
                    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
                }
            }, 2_000);
            timer.unref();
            for (const child of pending) {
                child.once('exit', settle);
                child.kill('SIGTERM');
            }
        });
    }
}
