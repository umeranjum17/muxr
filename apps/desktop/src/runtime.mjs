/**
 * The muxr runtime the desktop app supervises: the repo's own relay and host,
 * started as child processes exactly as `scripts/setup/presentation/up.mjs`
 * starts them for development. The app owns no host logic; it writes the same
 * self-host state a `muxr setup` writes and then starts the host beside it.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, machineIdentity } from '../../../scripts/setup/infrastructure/runtime.mjs';
import { waitForRelay } from '../../../scripts/diagnostics/application/waitForRelay.mjs';

const CLI_RUNNING_MESSAGE = 'muxr is already running on this computer from the command-line install. Pair from there with: muxr pair';

export class RelayOwnedError extends Error {
    constructor(message, pid) {
        super(message);
        this.name = 'RelayOwnedError';
        this.pid = pid;
    }
}

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

// How long a quiet start runs before the window offers Try again. Only the
// message waits on it: the relay's and host's own reports still win after it.
const HOST_STALL_MS = 30_000;

/**
 * Start the relay and host for `home`, then wait until the host is online.
 * Emits `status` events: 'starting', 'stalled', 'online', 'error'.
 */
export class MuxrRuntime extends EventEmitter {
    #home;
    #node;
    #relayEntry;
    #hostEntry;
    #port;
    #children = [];
    #stopping = false;
    #stallMs;

    constructor({ home, node, relayEntry, hostEntry, port, stallMs = HOST_STALL_MS }) {
        super();
        this.#home = home;
        this.#node = node;
        this.#relayEntry = relayEntry;
        this.#hostEntry = hostEntry;
        this.#port = port;
        this.#stallMs = stallMs;
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
        child.on('error', (error) => {
            if (this.#stopping) return;
            this.emit('status', { phase: 'error', message: `${label} could not start: ${error.message}` });
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
        const closed = new Promise((resolve) => relay.once('close', resolve));
        try {
            return await waitForRelay(relay, Infinity);
        } catch (error) {
            if (relay.exitCode !== null || relay.signalCode !== null) await closed;
            const message = error instanceof Error ? error.message : String(error);
            if (output.includes('another relay already owns')) {
                const ownerText = output.trim();
                const ownerPid = /\(pid (\d+)\)/.exec(ownerText)?.[1];
                const ownerMessage = ownerPid === undefined
                    ? 'An earlier muxr desktop session is still running. Quit it, or restart the computer, then try again.'
                    : `An earlier muxr desktop session is still running (process ${ownerPid}). Quit it, or restart the computer, then try again.`;
                this.emit('status', { phase: 'already-running', message: ownerMessage, canRetry: true });
                throw new RelayOwnedError(ownerText, ownerPid === undefined ? undefined : Number(ownerPid));
            }
            if (!this.#stopping) this.emit('status', { phase: 'error', message });
            throw error;
        } finally {
            relay.stdout?.off('data', collect);
            relay.stderr?.off('data', collect);
            output = '';
        }
    }

    async start() {
        this.emit('status', { phase: 'starting', message: 'Starting muxr on this computer' });
        const stall = setTimeout(() => {
            if (!this.#stopping) this.emit('status', { phase: 'stalled' });
        }, this.#stallMs);
        try { await this.#start(); }
        catch (error) {
            // Try again stops a start that is still waiting; its own kill is not a failure.
            if (this.#stopping) return;
            throw error;
        } finally { clearTimeout(stall); }
        if (this.#stopping) return;
        this.emit('status', { phase: 'online' });
    }

    async #start() {
        mkdirSync(this.#home, { recursive: true, mode: 0o700 });
        const relayDataDir = join(this.#home, 'relay');

        // The app owns the relay and host only for the state it wrote itself.
        // State from the command-line install means muxr is already running
        // there, so the desktop refuses instead of racing it.
        const statePath = join(this.#home, 'selfhost.json');
        let existing;
        if (existsSync(statePath)) {
            try {
                existing = JSON.parse(readFileSync(statePath, 'utf8'));
            } catch {
                throw new Error(`muxr's saved state at ${statePath} could not be read; it may belong to a command-line install, so the app will not overwrite it. Repair or remove that file, then try again.`);
            }
        }
        if (existing !== undefined && existing?.createdBy !== 'desktop') {
            this.emit('status', { phase: 'already-running', message: CLI_RUNNING_MESSAGE, canRetry: false });
            throw new RelayOwnedError(CLI_RUNNING_MESSAGE);
        }
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
                createdBy: 'desktop',
                machine: machineIdentity(undefined),
                relayRole: 'single-machine',
                connectionMode: 'lan',
                relayPort: boundPort,
                relayUrl: advertised,
                relayLocation: 'local',
                mintSecret: JSON.parse(readFileSync(join(relayDataDir, 'mint-secret'), 'utf8')),
            };
            atomicWrite(statePath, `${JSON.stringify(state)}\n`, 0o600);
            this.emit('log', 'runtime', `relay on :${boundPort}, advertised ${advertised}\n`);
        } else {
            await this.#awaitRelay(this.#spawnRelay(existing.relayPort, existing));
            this.emit('log', 'runtime', `using the existing self-host state at ${statePath}\n`);
        }

        if (this.#stopping) return;
        const host = this.#spawn(this.#hostEntry, {
            MUXR_MODE: 'selfhost',
            MUXR_HOME: this.#home,
            MUXR_DATA_DIR: join(this.#home, 'host'),
            // This app owns and runs this host, so the phone leads with the
            // window's Install Herdr instead of a terminal command.
            MUXR_DESKTOP_APP: '1',
        }, 'host');

        await this.#hostOnline(host);
    }

    /**
     * Resolve when the host reports its link online and its pairing socket
     * exists; the stall timer covers the wait. Reject when it exits or cannot
     * start.
     */
    #hostOnline(host) {
        return new Promise((resolve, reject) => {
            let out = '';
            let poll;
            const settle = () => {
                host.stdout?.off('data', collect);
                host.off('exit', exited);
                host.off('error', failed);
                clearTimeout(poll);
                out = '';
            };
            const awaitPairSocket = () => {
                if (!existsSync(this.pairSocketPath)) { poll = setTimeout(awaitPairSocket, 300); return; }
                settle();
                resolve();
            };
            const collect = (chunk) => {
                out += chunk.toString();
                if (!out.includes('link relay: online')) return;
                host.stdout?.off('data', collect);
                out = '';
                awaitPairSocket();
            };
            const ended = (reason) => () => {
                settle();
                if (this.#stopping) resolve();
                else reject(new Error(reason));
            };
            const exited = ended('the muxr host exited before it came online');
            const failed = ended('the muxr host could not be started');
            host.stdout?.on('data', collect);
            host.once('exit', exited);
            host.once('error', failed);
        });
    }

    stop() {
        this.#stopping = true;
        const children = this.#children;
        this.#children = [];
        const pending = new Set(children.filter((child) => child.pid !== undefined && child.exitCode === null && child.signalCode === null));
        if (pending.size === 0) return Promise.resolve();
        return new Promise((resolve) => {
            let timer;
            const settle = (child) => {
                pending.delete(child);
                if (pending.size > 0) return;
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
                child.once('exit', () => settle(child));
                child.once('error', () => settle(child));
                child.once('close', () => settle(child));
                child.kill('SIGTERM');
            }
        });
    }
}
