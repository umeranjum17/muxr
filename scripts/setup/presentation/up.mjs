/**
 * One command: relay + host with a matching machine id.
 * Replaces the manual three-terminal path for day-to-day dev.
 */
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { waitForRelay } from '../../diagnostics/index.mjs';
import { hostEntry, relayEntry } from '../infrastructure/paths.mjs';

function env(name) {
    return process.env[name]?.trim() || undefined;
}

const port = Number(env('MUXR_RELAY_PORT') ?? 8792);
const machineId = env('MUXR_MACHINE_ID') || 'devbox';
// The source harness stays loopback-only because it exposes synthetic account
// APIs and permits cleartext. Use `muxr setup` for a real phone.
const relayHost = env('MUXR_RELAY_HOST') ?? '127.0.0.1';
const loopbackOnly = relayHost === '127.0.0.1' || relayHost === '::1' || relayHost === 'localhost';

const relayEnv = {
    ...process.env,
    MUXR_RELAY_HOST: relayHost,
    MUXR_RELAY_PORT: String(port),
    // The one-command loopback harness intentionally exposes the legacy
    // account fixture; production/user-operated relays never do.
    MUXR_RELAY_DEVELOPMENT_API: '1',
};

const hostEnv = {
    ...process.env,
    MUXR_MODE: 'local',
    MUXR_MACHINE_ID: machineId,
    MUXR_RELAY_URL: env('MUXR_RELAY_URL') ?? `ws://127.0.0.1:${port}`,
    ...(env('MUXR_RELAY_TOKEN') ? { MUXR_RELAY_TOKEN: env('MUXR_RELAY_TOKEN') } : {}),
};

/**
 * Mint an account token (for the app) and a machine token (for the host).
 * Reuses the relay endpoints proven by scripts/diagnostics/application/checkStrictAuth.mjs.
 */
async function provisionTokens() {
    const base = `http://127.0.0.1:${port}`;
    const post = async (path, body, token) => {
        const res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        if (res.status !== 201) throw new Error(`${path} returned ${res.status}`);
        return res.json();
    };
    const account = await post('/v1/accounts', {});
    const machine = await post('/v1/machines', { machineId }, account.token);
    return { accountToken: account.token, machineToken: machine.token };
}

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
if (await portInUse(port)) {
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

try {
    await waitForRelay(port);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    finish(1);
}

// Off loopback the relay is strict, so both sides need tokens before they can
// connect at all.
let accountToken;
if (!loopbackOnly && !hostEnv.MUXR_RELAY_TOKEN) {
    try {
        const tokens = await provisionTokens();
        accountToken = tokens.accountToken;
        hostEnv.MUXR_RELAY_TOKEN = tokens.machineToken;
    } catch (error) {
        process.stderr.write(`could not provision relay tokens: ${error instanceof Error ? error.message : String(error)}\n`);
        finish(1);
    }
}

const host = spawn('node', [hostEntry()], {
    env: hostEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(host);
prefixOutput(host, 'host', process.stdout);
host.on('exit', (code, signal) => onChildExit('host', code, signal));

const lanIps = lanIpv4Addresses();
const phoneRelay = lanIps.length > 0 ? `ws://${lanIps[0]}:${port}` : `ws://<lan-ip>:${port}`;
const localRelay = `ws://127.0.0.1:${port}`;

if (!process.argv.includes('--quiet')) process.stdout.write(`
=== muxr ===

Relay:       ${phoneRelay}
Machine ID:  ${machineId}
${accountToken === undefined ? '' : `Token:       ${accountToken}\n`}${accountToken === undefined
    ? 'Auth:        permissive (loopback only)\n'
    : 'Auth:        strict. Token is minted fresh each run \u2014 anyone holding it can\n'
      + '             drive this machine.\n'}
Start the app \u2014 copy this whole block:

  cd apps/mobile && \\
    EXPO_PUBLIC_MUXR_MODE=local \\
    EXPO_PUBLIC_MUXR_RELAY_URL=${phoneRelay} \\
    EXPO_PUBLIC_MUXR_MACHINE_ID=${machineId} \\
${accountToken === undefined ? '' : `    EXPO_PUBLIC_MUXR_TOKEN=${accountToken} \\\n`}    npm start

Or enter the same values in the app under Settings > Connection, which saves
them on the device and reconnects without restarting the bundler. A phone must
use the LAN address above, not 127.0.0.1. For the simulator or web on this
machine use ${localRelay}.

Stop all:    Ctrl-C (kills relay and host)

`);

await new Promise(() => {});
