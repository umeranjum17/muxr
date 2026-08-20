/**
 * Proves browser preview end to end: the host probes a local HTTP port, the
 * relay pairs two preview sockets it cannot read, and a real HTTP request
 * crosses the tunnel and comes back with its body intact.
 */
import { waitForRelay } from './waitForRelay.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodePreviewFrame, encodePreviewFrame, PREVIEW_DATA } from '@muxr/contract';

// A frame must survive a round trip with its payload byte-identical.
const round = decodePreviewFrame(encodePreviewFrame(70000, PREVIEW_DATA, new Uint8Array([1, 2, 255])));
assert.equal(round.connId, 70000, 'connId must survive above 16 bits');
assert.deepEqual([...round.payload], [1, 2, 255]);
assert.equal(decodePreviewFrame(new Uint8Array([1, 2])), undefined, 'short frame rejected');

process.stdout.write('frame codec OK\n');

// --- end to end -------------------------------------------------------------

// A fixed port collides with whatever the developer already has running, which
// reads as a failure of this check rather than of the port.
async function freePort() {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return String(port);
}

const PORT = process.env.MUXR_RELAY_PORT ?? (await freePort());
const MACHINE = 'preview-check';
const RELAY = `ws://127.0.0.1:${PORT}`;
const MARKER = 'muxr-preview-marker-9f2c';

const children = [];
const done = (code, msg) => {
    process.stdout.write(msg);
    for (const c of children) c.kill('SIGTERM');
    devServer.close();
    process.exit(code);
};

// Stands in for `vite`/`next dev`. Bound to loopback on purpose: reaching it at
// all is the thing a LAN address or a public tunnel could not do.
const devServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ marker: MARKER, path: req.url }));
});
await new Promise((resolve) => devServer.listen(0, '127.0.0.1', resolve));
const devPort = devServer.address().port;
process.stdout.write(`dev server on 127.0.0.1:${devPort}\n`);

const scratch = mkdtempSync(join(tmpdir(), 'muxr-preview-e2e-'));
const env = { ...process.env };
// A live deployment exports these. Inherited, the throwaway relay below refuses
// the host and the failure looks like a code regression.
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_E2EE_SHARED_KEY', 'MUXR_RELAY_AUTH']) {
    delete env[key];
}
Object.assign(env, {
    MUXR_MODE: 'local',
    MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: PORT,
    MUXR_RELAY_URL: RELAY,
    MUXR_MACHINE_ID: MACHINE,
    MUXR_RELAY_DATA_DIR: join(scratch, 'relay'),
});
const start = (name, args) => {
    const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
    children.push(child);
};

start('relay', ['apps/relay/dist/main.js']);
await waitForRelay(PORT);
start('host', ['apps/host/dist/main.js', '--fake']);
await delay(900);

const session = new WebSocket(`${RELAY}?role=client&machineId=${MACHINE}`);
const timer = setTimeout(() => done(1, '\nFAIL: no preview response within 25s\n'), 25000);
let seq = 0;
const send = (frame) => {
    seq += 1;
    session.send(JSON.stringify({
        header: { machineId: MACHINE, seq, at: Date.now() },
        payload: JSON.stringify(frame),
    }));
};

const CHANNEL = 'check-channel-1';
const BRIDGE_CHANNEL = 'check-channel-2';

session.on('open', () => send({ type: 'preview.probe', requestId: 'p1', params: { port: devPort } }));

session.on('message', (raw) => {
    const frame = JSON.parse(JSON.parse(String(raw)).payload);
    if (frame.type !== 'result') return;

    if (frame.requestId === 'p1') {
        if (!frame.ok) done(1, `\nFAIL: preview.probe errored: ${frame.error}\n`);
        if (frame.data?.contentType !== 'application/json') {
            done(1, `\nFAIL: probe of dev server on ${devPort} saw: ${JSON.stringify(frame.data)}\n`);
        }
        send({ type: 'preview.attach', requestId: 'p2', params: { channel: CHANNEL, port: devPort } });
        return;
    }

    if (frame.requestId === 'p2') {
        if (!frame.ok) done(1, `\nFAIL: preview.attach errored: ${frame.error}\n`);
        openTunnel();
        return;
    }

    if (frame.requestId === 'p3') {
        if (!frame.ok) done(1, `\nFAIL: bridge preview.attach errored: ${frame.error}\n`);
        bridgeResolve();
    }
});

let bridgeResolve;
const bridgeAttached = new Promise((resolve) => { bridgeResolve = resolve; });

/**
 * The device end of the bridge: the listener lives here, not on the relay, so
 * the preview works against a relay published only on 443.
 */
async function runBridge() {
    send({ type: 'preview.attach', requestId: 'p3', params: { channel: BRIDGE_CHANNEL, port: devPort } });
    await bridgeAttached;

    const control = new WebSocket(`${RELAY}/preview?role=client&machineId=${MACHINE}&channel=${BRIDGE_CHANNEL}&bridge=1`);
    const connections = new Map();
    let nextConnId = 0;

    await new Promise((resolve, reject) => {
        control.on('error', reject);
        control.on('message', (raw, isBinary) => {
            if (!isBinary) {
                if (JSON.parse(String(raw)).type === 'preview.bridge') resolve();
                return;
            }
            const frame = decodePreviewFrame(new Uint8Array(raw));
            const socket = connections.get(frame.connId);
            if (socket === undefined) return;
            if (frame.payload.length > 0) socket.write(Buffer.from(frame.payload));
        });
        setTimeout(() => reject(new Error('relay never paired the bridge')), 10000);
    });

    const local = createTcpServer((socket) => {
        nextConnId += 1;
        const connId = nextConnId;
        connections.set(connId, socket);
        socket.on('data', (chunk) => control.send(encodePreviewFrame(connId, PREVIEW_DATA, new Uint8Array(chunk)), { binary: true }));
        socket.on('close', () => connections.delete(connId));
    });
    await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
    const localPort = local.address().port;

    const response = await fetch(`http://127.0.0.1:${localPort}/bridged`, { signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    local.close();
    control.close();
    if (response.status !== 200 || !body.includes(MARKER) || !body.includes('/bridged')) {
        done(1, `\nFAIL: bridged request got: ${response.status} ${body.slice(0, 300)}\n`);
    }
    return localPort;
}

function openTunnel() {
    const control = new WebSocket(`${RELAY}/preview?role=client&machineId=${MACHINE}&channel=${CHANNEL}`);

    control.on('message', async (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== 'preview.ready') return;
        clearTimeout(timer);

        // A real HTTP client over the relay's listener: proves the whole path,
        // including that the preview is served at a root path.
        try {
            const response = await fetch(`http://127.0.0.1:${message.port}/index.html`, {
                signal: AbortSignal.timeout(10000),
            });
            const body = await response.text();
            const ok = response.status === 200 && body.includes(MARKER) && body.includes('/index.html');
            if (!ok) {
                done(1, `\nFAIL: unexpected response: ${response.status} ${body.slice(0, 300)}\n`);
            }

            // Second request on a fresh connection: a browser opens several per
            // page, so the mux has to keep them apart.
            const again = await fetch(`http://127.0.0.1:${message.port}/second`, {
                signal: AbortSignal.timeout(10000),
            });
            const againBody = await again.text();
            if (!againBody.includes('/second')) {
                done(1, `\nFAIL: second connection got: ${againBody.slice(0, 300)}\n`);
            }

            // A loopback websocket is treated as the documented local TLS-proxy
            // path, where the relay cannot recover the phone's source address;
            // the current development fixture intentionally skips the IP pin.
            const relayHost = new URL(RELAY).hostname;
            const pinned = relayHost === '127.0.0.1' || relayHost === '::1'
                ? undefined
                : await refusedFromOtherAddress(message.port);
            if (pinned === false) {
                done(1, '\nFAIL: preview port served a client it was not opened for\n');
            }

            const bridgedPort = await runBridge();

            done(0, `\nPASS: browser preview through the relay\n`
                + `      loopback port probed: application/json\n`
                + `      loopback-bound dev server reached: yes\n`
                + `      preview port: ${message.port}\n`
                + `      concurrent connections muxed: yes\n`
                + `      foreign source address refused: ${pinned === undefined ? 'skipped' : 'yes'}\n`
                + `      device-side bridge port: ${bridgedPort}\n`
                + `      body bytes: ${body.length}\n`);
        } catch (error) {
            done(1, `\nFAIL: request through preview port: ${error.message}\n`);
        }
    });

    control.on('error', (error) => done(1, `\nFAIL: preview control socket: ${error.message}\n`));
}

/**
 * true  = refused, which is what the pin promises.
 * false = served, which is the leak.
 * undefined = this host has no second loopback address to test from.
 */
function refusedFromOtherAddress(port) {
    return new Promise((resolve) => {
        let socket;
        try {
            socket = connect({ port, host: '127.0.0.1', localAddress: '127.0.0.2' });
        } catch {
            resolve(undefined);
            return;
        }
        const settle = (value) => {
            socket.destroy();
            resolve(value);
        };
        // EADDRNOTAVAIL means no 127.0.0.2 on this box (macOS); not a result.
        socket.on('error', (error) => settle(error.code === 'EADDRNOTAVAIL' ? undefined : true));
        socket.on('close', () => resolve(true));
        socket.on('connect', () => {
            socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        });
        socket.on('data', () => settle(false));
        setTimeout(() => settle(true), 2500);
    });
}

session.on('error', (error) => done(1, `\nFAIL: session socket: ${error.message}\n`));
