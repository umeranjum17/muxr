/**
 * One command: relay + host with a matching machine id.
 * Replaces the manual three-terminal path for day-to-day dev.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForRelay } from '../../diagnostics/index.mjs';
import { hostEntry, namingEntry, relayEntry } from '../infrastructure/paths.mjs';
import { machineIdentity } from '../infrastructure/runtime.mjs';

function env(name) {
    return process.env[name]?.trim() || undefined;
}

const port = Number(env('MUXR_RELAY_PORT') ?? 8792);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const home = env('MUXR_HOME') ?? join(root, '.cache', 'muxr-up');
// Development state is private to this checkout, never the owner's installed host.
const relayHost = env('MUXR_RELAY_HOST') ?? '127.0.0.1';

const relayEnv = {
    ...process.env,
    MUXR_RELAY_HOST: relayHost,
    MUXR_RELAY_PORT: String(port),
    MUXR_RELAY_DATA_DIR: env('MUXR_RELAY_DATA_DIR') ?? join(home, 'relay'),
};

const hostEnv = {
    ...process.env,
    MUXR_MODE: 'selfhost',
    MUXR_HOME: home,
    MUXR_DATA_DIR: env('MUXR_DATA_DIR') ?? join(home, 'host'),
};

function lanIpv4Addresses() {
    const out = [];
    for (const entries of Object.values(networkInterfaces())) {
        if (entries === undefined) continue;
        for (const entry of entries) {
            if (entry.internal || entry.family !== 'IPv4') continue;
            out.push(entry.address);
        }
    }
    return out;
}

function prefixOutput(child, label, stream) {
    child.stdout?.on('data', (chunk) => stream.write(`[${label}] ${chunk}`));
    child.stderr?.on('data', (chunk) => stream.write(`[${label}] ${chunk}`));
}

const children = [];
let shuttingDown = false;
let exitCode = 0;

function killChildren(signal = 'SIGTERM') {
    for (const child of children) {
        if (child.exitCode === null) child.kill(signal);
    }
}

function exitWhenChildrenDone(code = 0) {
    exitCode = code;
    const pending = children.filter((child) => child.exitCode === null);
    if (pending.length === 0) {
        process.exit(exitCode);
        return;
    }
    let left = pending.length;
    for (const child of pending) {
        child.once('exit', () => {
            left -= 1;
            if (left === 0) process.exit(exitCode);
        });
    }
    setTimeout(() => {
        killChildren('SIGKILL');
        process.exit(exitCode);
    }, 2000).unref();
}

function finish(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    killChildren('SIGTERM');
    exitWhenChildrenDone(code);
}

function onChildExit(label, code, signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
    process.stderr.write(`\n${label} exited (${detail}). Stopping the other process.\n`);
    if (label === 'host' && code === 1) {
        process.stderr.write(
            'Host failed — if the herdr server is not running, start it with `herdr server`, '
            + 'or use `node apps/host/dist/main.js --fake`.\n',
        );
    }
    killChildren('SIGTERM');
    exitWhenChildrenDone(code === null ? 1 : code);
}

function portInUse(candidate) {
    return new Promise((resolve) => {
        const probe = connect({ port: candidate, host: '127.0.0.1' });
        probe.setTimeout(700);
        const settle = (answer) => { probe.destroy(); resolve(answer); };
        probe.on('connect', () => settle(true));
        probe.on('error', () => settle(false));
        probe.on('timeout', () => settle(false));
    });
}

process.on('SIGINT', () => {
    process.stdout.write('\n');
    finish(0);
});
process.on('SIGTERM', () => finish(0));

// Running `up` twice, or having a relay already going, is the most likely
// first-run failure. Node's raw EADDRINUSE stack trace is a terrible thing to
// hand someone whose first command this is.
if (port !== 0 && await portInUse(port)) {
    process.stderr.write(
        `Port ${port} is already in use — a relay is probably already running.\n`
        + `Stop it, or pick another port with MUXR_RELAY_PORT=<port> npm run up\n`,
    );
    process.exit(1);
}

const relay = spawn('node', [relayEntry()], {
    env: relayEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(relay);
prefixOutput(relay, 'relay', process.stdout);
relay.on('exit', (code, signal) => onChildExit('relay', code, signal));

let boundPort;
let state;
try {
    // Waits on the relay we just spawned, not on the port: a relay that dies at
    // startup says so here instead of burning the timeout, and a stranger
    // already on the port can never be mistaken for ours.
    boundPort = await waitForRelay(relay);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const statePath = join(home, 'selfhost.json');
    state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {
        version: 1, machine: machineIdentity(undefined), relayRole: 'single-machine', connectionMode: 'lan',
    };
    if (!state.machine?.id || !state.machine?.crypto) throw new Error('development self-host state is invalid; refusing to replace its pairing identity');
    const lanIp = lanIpv4Addresses()[0];
    const advertised = env('MUXR_RELAY_URL') ?? `ws://${relayHost === '127.0.0.1' ? '127.0.0.1' : lanIp ?? relayHost}:${boundPort}`;
    Object.assign(state, { relayPort: boundPort, relayUrl: advertised,
        relayLocation: 'local', mintSecret: JSON.parse(readFileSync(join(relayEnv.MUXR_RELAY_DATA_DIR, 'mint-secret'), 'utf8')) });
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    finish(1);
    await new Promise(() => {});
}

const host = spawn('node', [hostEntry()], {
    env: hostEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(host);
prefixOutput(host, 'host', process.stdout);
host.on('exit', (code, signal) => onChildExit('host', code, signal));

// The agent self-naming endpoint: agents POST their own workspace/pane names.
// Decoupled on purpose — a naming failure degrades to the fallback namers, it
// must never take the relay or host down.
const naming = spawn('node', [namingEntry()], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(naming);
prefixOutput(naming, 'naming', process.stdout);
naming.on('exit', (code, signal) => {
    if (!shuttingDown) process.stderr.write(`[naming] exited (code ${code ?? ''}${signal ? ` ${signal}` : ''}); self-naming unavailable until restart\n`);
});

const phoneRelay = state.relayUrl;
const localRelay = `ws://127.0.0.1:${boundPort}`;

if (!process.argv.includes('--quiet')) process.stdout.write(`
=== muxr ===

Relay:       ${phoneRelay}
Machine ID:  ${state.machine.id}
Pair:        MUXR_HOME=${home} muxr pair

Scan the fresh link QR in the app. For a LAN phone, set MUXR_RELAY_HOST=0.0.0.0
before starting up; the default is loopback only. For web on this machine use
${localRelay}. Pairing stores the connection securely in the browser;
build-time EXPO_PUBLIC_MUXR_* values do not configure web.

Stop all:    Ctrl-C (kills relay and host)

`);

await new Promise(() => {});
