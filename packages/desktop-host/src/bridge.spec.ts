import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Bridge, BRIDGE_PATH } from './bridge.js';
import type { EngineEvent } from './protocol.js';

/**
 * The third-party seam: a consumer with no signaling channel of its own.
 *
 * The bridge is the only part of these packages that listens on a socket, so it
 * is also the only part where getting authorisation wrong is a remote-control
 * port for anyone who finds it. These checks are about that, and about the
 * protocol surviving the trip.
 */
const STUB = `
const readline = require('node:readline');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'hello') return out({ id: request.id, result: { protocol: 2 } });
  if (request.method === 'session.open') {
    out({ event: 'session.restoreToken', params: { sessionId: 'engine-1', token: 'test-private-grant' } });
    setTimeout(() => out({ event: 'session.description', params: { generation: 1, description: { type: 'offer', sdp: 'v=0 offer' } } }), 5);
    return out({ id: request.id, result: {
      sessionId: 'engine-1', generation: 1,
      source: { kind: 'monitor', width: 100, height: 100, origin: { x: 0, y: 0 } },
      geometry: { source: { width: 100, height: 100 }, encoded: { width: 100, height: 100 }, origin: { x: 0, y: 0 } },
    } });
  }
  if (request.method === 'shutdown') { out({ id: request.id, result: {} }); process.exit(0); }
  return out({ id: request.id, error: { code: 'operation', message: 'unknown' } });
});
`;

const bridges: Bridge[] = [];
const servers = new Set<WebSocket>();

afterEach(async () => {
    for (const socket of servers) socket.close();
    servers.clear();
    for (const bridge of bridges.splice(0)) await bridge.close();
});

async function startBridge(token: string, serveExample = true): Promise<{ bridge: Bridge; port: number; localEvents: EngineEvent[] }> {
    const directory = mkdtempSync(join(tmpdir(), 'desklink-bridge-'));
    const script = join(directory, 'engine.cjs');
    writeFileSync(script, STUB);
    const localEvents: EngineEvent[] = [];
    const bridge = await Bridge.start({
        listen: '127.0.0.1:0',
        token,
        engineCommand: process.execPath,
        engineArgs: [script],
        engineOptions: { onEvent: (event) => localEvents.push(event) },
        serveExample,
    });
    bridges.push(bridge);
    return { bridge, port: bridge.port, localEvents };
}

function connect(port: number, query: string): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}?${query}`);
    servers.add(socket);
    return new Promise((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
        socket.once('unexpected-response', (_request, response) => reject(new Error(`refused: ${response.statusCode}`)));
    });
}

function requestOn(socket: WebSocket, id: number, method: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
        const onMessage = (raw: WebSocket.RawData): void => {
            const message = JSON.parse(String(raw)) as { id?: number; result?: Record<string, unknown> };
            if (message.id !== id) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(message.result ?? {});
        };
        socket.on('message', onMessage);
        socket.send(JSON.stringify({ id, method, params: {} }));
    });
}

describe('the bridge', () => {
    it('refuses a socket without the token and serves the protocol with it', async () => {
        const { port, localEvents } = await startBridge('s3cret');
        await expect(connect(port, 'token=wrong')).rejects.toThrow(/refused|401/);

        const socket = await connect(port, 'token=s3cret');
        const received: string[] = [];
        socket.on('message', (raw) => received.push(String(raw)));
        const opened = await requestOn(socket, 1, 'session.open');
        expect(opened).toMatchObject({ sessionId: 'engine-1', generation: 1 });
        expect((opened.geometry as { encoded: unknown }).encoded).toEqual({ width: 100, height: 100 });

        // The engine's own notification reaches the socket unchanged: a client
        // that only speaks the documented protocol can see the offer.
        const event = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no notification')), 5000);
            socket.on('message', (raw) => {
                const message = JSON.parse(String(raw)) as { event?: string; params?: Record<string, unknown> };
                if (message.event !== 'session.description') return;
                clearTimeout(timer);
                resolve(message.params ?? {});
            });
        });
        expect(event).toMatchObject({ description: { type: 'offer', sdp: 'v=0 offer' } });
        // Persistence belongs to the host consumer, never to the remote controller.
        expect(received.join('\n')).not.toContain('test-private-grant');
        expect(localEvents).toContainEqual({
            event: 'session.restoreToken', params: { sessionId: 'engine-1', token: 'test-private-grant' },
        });
    }, 20_000);

    it('serves the reference page only to a caller that already has the token', async () => {
        const { port } = await startBridge('s3cret');
        const get = (path: string): Promise<number> =>
            new Promise((resolve, reject) => {
                fetch(`http://127.0.0.1:${port}${path}`)
                    .then((response) => resolve(response.status))
                    .catch(reject);
            });
        expect(await get('/')).toBe(404);
        expect(await get('/?token=wrong')).toBe(404);
        expect(await get('/?token=s3cret')).toBe(200);
    }, 20_000);

    it('forwards a request for a desktop the bridge is configured to offer', async () => {
        // A bridge is bound to one machine and one desktop, so it fills in the
        // source a client is not in a position to know.
        const directory = mkdtempSync(join(tmpdir(), 'desklink-bridge-'));
        const script = join(directory, 'engine.cjs');
        writeFileSync(
            script,
            STUB.replace("if (request.method === 'session.open') {", "if (request.method === 'session.open') {\n    out({ event: 'seen', params: { source: request.params.source ?? null } });"),
        );
        const bridge = await Bridge.start({
            listen: '127.0.0.1:0',
            token: 't',
            engineCommand: process.execPath,
            engineArgs: [script],
            source: { kind: 'x11', display: ':99' },
            serveExample: false,
        });
        bridges.push(bridge);
        const socket = await connect(bridge.port, 'token=t');
        const seen = new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no notification')), 5000);
            socket.on('message', (raw) => {
                const message = JSON.parse(String(raw)) as { event?: string; params?: { source?: unknown } };
                if (message.event !== 'seen') return;
                clearTimeout(timer);
                resolve({ source: message.params?.source });
            });
        });
        await requestOn(socket, 1, 'session.open');
        expect(await seen).toEqual({ source: { kind: 'x11', display: ':99' } });
    }, 20_000);

    it('closes the engine session when its last consumer goes away, and only then', async () => {
        // A consumer that dies mid-gesture — a closed tab, a lost phone, a
        // killed process — must not leave the desktop holding synthetic input
        // until the engine's one-hour lease expires.
        const directory = mkdtempSync(join(tmpdir(), 'desklink-bridge-'));
        const script = join(directory, 'engine.cjs');
        const log = join(directory, 'engine.log');
        writeFileSync(script, `
const fs = require('node:fs');
const readline = require('node:readline');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, request.method + ' ' + JSON.stringify(request.params ?? {}) + '\\n');
  if (request.method === 'hello') return out({ id: request.id, result: { protocol: 2 } });
  if (request.method === 'session.open') return out({ id: request.id, result: { sessionId: 'engine-1', generation: 7 } });
  if (request.method === 'session.close') return out({ id: request.id, result: { closed: true } });
  if (request.method === 'shutdown') { out({ id: request.id, result: {} }); process.exit(0); }
  return out({ id: request.id, error: { code: 'operation', message: 'unknown' } });
});
`);
        const sent = (): string[] => {
            try {
                return readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
            } catch {
                return [];
            }
        };

        const bridge = await Bridge.start({
            listen: '127.0.0.1:0',
            token: 't',
            engineCommand: process.execPath,
            engineArgs: [script],
            serveExample: false,
        });
        bridges.push(bridge);
        const first = await connect(bridge.port, 'token=t');
        await requestOn(first, 1, 'session.open');
        const second = await connect(bridge.port, 'token=t');

        // The session outlives the consumer that opened it while another one is
        // still attached: the bridge closes it only when nobody is left.
        first.close();
        await requestOn(second, 2, 'session.metrics');
        expect(sent()).toContain('session.open {}');
        expect(sent().filter((line) => line.startsWith('session.close'))).toEqual([]);

        second.close();
        const deadline = Date.now() + 5000;
        while (!sent().some((line) => line.startsWith('session.close')) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(sent()).toContain('session.close {"session_id":"engine-1","generation":7}');
    }, 20_000);
});
