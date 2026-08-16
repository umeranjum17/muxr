/**
 * Proves browser preview end to end: the host finds a local HTTP server, the
 * relay pairs two preview sockets it cannot read, and a real HTTP request
 * crosses the tunnel and comes back with its body intact.
 *
 * Also asserts the listener parsers, which are the one piece with no runtime
 * feedback when they silently return nothing.
 */
import { waitForRelay } from './waitForRelay.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodePreviewFrame, encodePreviewFrame, PREVIEW_DATA } from '@muxr/contract';
import { parseLsofListeners, parseSsListeners } from '../apps/host/dist/requests/preview.js';

// --- parsers ----------------------------------------------------------------

const ss = parseSsListeners([
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN 0      511          127.0.0.1:8080       0.0.0.0:*    users:(("node",pid=4039084,fd=21))',
    'LISTEN 0      511                  *:8081             *:*    users:(("node-MainThread",pid=509184,fd=101))',
    'LISTEN 0      4096             [::1]:9000          [::]:*    users:(("postgres",pid=77,fd=6))',
    'ESTAB  0      0            10.0.0.1:1234       10.0.0.2:80',
].join('\n'));
assert.equal(ss.length, 3, 'ss: only LISTEN rows');
assert.deepEqual(ss[0], { port: 8080, bind: '127.0.0.1', command: 'node', pid: 4039084 });
assert.equal(ss[1].bind, '*', 'ss: wildcard bind kept as reported');
assert.equal(ss[2].port, 9000, 'ss: ipv6 bracket form');
assert.equal(ss[2].bind, '[::1]');

const lsof = parseLsofListeners([
    'COMMAND   PID USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME',
    'node    12345 umer   21u  IPv4 0x1234      0t0  TCP 127.0.0.1:5173 (LISTEN)',
    'node    12345 umer   22u  IPv4 0x1235      0t0  TCP 10.0.0.4:443->10.0.0.9:52 (ESTABLISHED)',
].join('\n'));
assert.equal(lsof.length, 1, 'lsof: only LISTEN rows');
assert.deepEqual(lsof[0], { port: 5173, bind: '127.0.0.1', command: 'node', pid: 12345 });

// A frame must survive a round trip with its payload byte-identical.
const round = decodePreviewFrame(encodePreviewFrame(70000, PREVIEW_DATA, new Uint8Array([1, 2, 255])));
assert.equal(round.connId, 70000, 'connId must survive above 16 bits');
assert.deepEqual([...round.payload], [1, 2, 255]);
assert.equal(decodePreviewFrame(new Uint8Array([1, 2])), undefined, 'short frame rejected');

process.stdout.write('parsers + frame codec OK\n');

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
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body>${MARKER}${req.url}</body></html>`);
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
let listed;

session.on('open', () => send({ type: 'preview.list', requestId: 'p1', params: {} }));

session.on('message', (raw) => {
    const frame = JSON.parse(JSON.parse(String(raw)).payload);
    if (frame.type !== 'result') return;

    if (frame.requestId === 'p1') {
        if (!frame.ok) done(1, `\nFAIL: preview.list errored: ${frame.error}\n`);
        listed = frame.data;
        const found = listed.find((server) => server.port === devPort);
        if (!found) {
            done(1, `\nFAIL: dev server on ${devPort} not detected. saw: ${JSON.stringify(listed)}\n`);
        }
        if (listed.some((server) => server.port === Number(PORT))) {
            done(1, `\nFAIL: relay listed itself as a dev server\n`);
        }
        send({ type: 'preview.attach', requestId: 'p2', params: { channel: CHANNEL, port: devPort } });
        return;
    }

    if (frame.requestId === 'p2') {
        if (!frame.ok) done(1, `\nFAIL: preview.attach errored: ${frame.error}\n`);
        openTunnel();
    }
});

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

            done(0, `\nPASS: browser preview through the relay\n`
                + `      detected servers: ${listed.length}\n`
                + `      loopback-bound dev server reached: yes\n`
                + `      preview port: ${message.port}\n`
                + `      concurrent connections muxed: yes\n`
                + `      foreign source address refused: ${pinned === undefined ? 'skipped' : 'yes'}\n`
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
