/**
 * Strict-auth gate for remote exposure.
 *
 * A tunnel (cloudflared, ngrok, any reverse proxy) connects to the relay from
 * 127.0.0.1, so every remote peer LOOKS loopback. Permissive mode would let
 * those in unauthenticated, which is remote code execution on the host. This
 * asserts strict mode refuses them and that valid tokens still work.
 */
import { waitForRelay } from './waitForRelay.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = process.env.MUXR_RELAY_PORT ?? '8817';
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-strict-'));
const kids = [];
const done = (code, msg) => {
    process.stdout.write(msg);
    for (const c of kids) c.kill('SIGTERM');
    process.exit(code);
};

const relay = spawn('node', ['apps/relay/dist/main.js'], {
    env: { ...process.env, MUXR_RELAY_PORT: PORT, MUXR_RELAY_DATA_DIR: dataDir, MUXR_RELAY_AUTH: 'strict' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`));
kids.push(relay);
await waitForRelay(PORT);

/**
 * True only when the socket opens AND stays open. The relay refuses by
 * accepting the upgrade then closing with 1008, so `open` alone proves nothing.
 */
function tryConnect(query) {
    return new Promise((resolve) => {
        const socket = new WebSocket(`${WS}?${query}`);
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            socket.removeAllListeners();
            socket.close();
            resolve(value);
        };
        socket.on('close', (code) => finish(code !== 1008 && code !== 1002));
        socket.on('error', () => finish(false));
        socket.on('unexpected-response', () => finish(false));
        socket.on('open', () => setTimeout(() => finish(true), 400));
        setTimeout(() => finish(false), 4000);
    });
}

const post = async (path, body, token) => {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
};

// A tunnelled peer arrives from 127.0.0.1 with no token. It must be refused.
if (await tryConnect('role=machine&machineId=box')) {
    done(1, '\nFAIL: strict relay accepted a tokenless machine from loopback\n');
}
if (await tryConnect('role=client&machineId=box')) {
    done(1, '\nFAIL: strict relay accepted a tokenless client from loopback\n');
}
if (await tryConnect('role=client&machineId=box&token=nonsense')) {
    done(1, '\nFAIL: strict relay accepted a forged token\n');
}
if (await tryConnect('ticket=nonsense')) {
    done(1, '\nFAIL: strict relay accepted a forged ticket\n');
}

// Valid path: single-use tickets minted with the relay's mint secret.
const mintSecret = JSON.parse(readFileSync(join(dataDir, 'mint-secret'), 'utf8'));
const mint = async (body) => {
    const res = await post('/v1/ws-tickets', body, mintSecret);
    if (res.status !== 200 || typeof res.body.ticket !== 'string') done(1, `\nFAIL: ticket mint returned ${res.status}\n`);
    return res.body.ticket;
};

const machineTicket = await mint({ machineSlug: 'box', role: 'machine', transport: 'relay' });
if (!(await tryConnect(`ticket=${encodeURIComponent(machineTicket)}`))) {
    done(1, '\nFAIL: strict relay refused a valid machine ticket\n');
}
if (await tryConnect(`ticket=${encodeURIComponent(machineTicket)}`)) {
    done(1, '\nFAIL: strict relay accepted a reused ticket\n');
}
// Accept the pre-machineSlug camelCase client long enough for installed apps to reconnect.
const clientTicket = await mint({ machineId: 'box', role: 'client', transport: 'relay' });
if (!(await tryConnect(`ticket=${encodeURIComponent(clientTicket)}`))) {
    done(1, '\nFAIL: strict relay refused a valid client ticket\n');
}

done(
    0,
    '\nPASS: strict auth holds for remote exposure\n' +
        '      tokenless machine/client from loopback refused: yes\n' +
        '      forged token/ticket refused: yes   valid tickets accepted: yes\n' +
        '      single-use ticket reuse refused: yes\n',
);
