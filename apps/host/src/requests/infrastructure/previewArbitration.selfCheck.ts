/**
 * Takeover control arbitration selfCheck: exactly one controller per stream
 * port may send input, while watchers receive frames read-only.
 *
 * A fake relay pairs machine and client sockets per channel, a real `ws`
 * server stands in for the agent-browser stream binary, and the real
 * `openPreview` use case plus `attachPreview` byte pipe run between them
 * with real preview E2EE. Proves: a second controller is rejected, a watcher
 * still renders frames, watcher input never reaches the stream, controller
 * input does, and closing the controller frees the port.
 */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { deriveV2Key, newPreviewKey, openPreviewPayload, sealPreviewPayload } from '@muxr/crypto';
import {
    decodePreviewFrame,
    encodePreviewFrame,
    PREVIEW_DATA,
} from '@muxr/contract';
import { openPreview } from '../application/openPreview.js';
import { attachPreview } from './preview.js';

const MACHINE = 'arbitration-check';

/** Minimal relay: pairs machine and client sockets quoting the same channel. */
async function startFakeRelay(): Promise<{ url: string; close: () => void }> {
    const machines = new Map<string, WebSocket>();
    const clients = new Map<string, WebSocket>();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.on('listening', resolve));
    server.on('connection', (socket, request) => {
        const params = new URL(request.url ?? '', 'ws://relay').searchParams;
        const channel = params.get('channel') ?? '';
        const role = params.get('role');
        const store = role === 'machine' ? machines : clients;
        store.get(channel)?.close();
        store.set(channel, socket);
        socket.on('message', (data) => {
            const peer = (role === 'machine' ? clients : machines).get(channel);
            if (peer !== undefined && peer.readyState === WebSocket.OPEN) {
                peer.send(data as Buffer, { binary: true });
            }
        });
        socket.on('close', () => {
            if (store.get(channel) === socket) store.delete(channel);
            // Mirror the relay: losing one end tears down the pair, which is
            // what releases takeover control on the host.
            const peer = (role === 'machine' ? clients : machines).get(channel);
            if (peer !== undefined && peer.readyState === WebSocket.OPEN) peer.close();
        });
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const close = (): void => {
        for (const socket of server.clients) socket.terminate();
        server.close();
    };
    return { url: `ws://127.0.0.1:${port}`, close };
}

/** Stand-in for the agent-browser stream binary: speaks real WebSocket. */

/** Stand-in for the agent-browser stream binary: speaks real WebSocket. */
async function startStreamServer(): Promise<{ port: number; received: string[]; close: () => void }> {
    const received: string[] = [];
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.on('listening', resolve));
    server.on('connection', (socket) => {
        socket.send(JSON.stringify({ type: 'frame', data: Buffer.from('jpeg-bytes').toString('base64') }));
        socket.on('message', (data) => {
            received.push(String(data));
        });
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const close = (): void => {
        for (const socket of server.clients) socket.terminate();
        server.close();
    };
    return { port, received, close };
}

interface TestClient {
    sendRaw: (connId: number, payload: Uint8Array) => void;
    drain: () => Uint8Array[];
    close: () => void;
}

/** Device end of a channel: seals outbound, opens inbound, pumps on demand. */
function openTestClient(relayUrl: string, channel: string, key: string): Promise<TestClient & { socket: WebSocket }> {
    const clientToHost = deriveV2Key(key, 'client->host');
    const hostToClient = deriveV2Key(key, 'host->client');
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(
            `${relayUrl}/preview?role=client&machineId=${MACHINE}&channel=${encodeURIComponent(channel)}`,
        );
        socket.binaryType = 'nodebuffer';
        const inbox: Uint8Array[] = [];
        socket.on('message', (data) => {
            const frame = decodePreviewFrame(new Uint8Array(data as Buffer));
            if (frame === undefined || frame.flag !== PREVIEW_DATA || frame.payload.length === 0) return;
            inbox.push(openPreviewPayload(frame.payload, hostToClient));
        });
        socket.on('open', () => resolve({
            socket,
            sendRaw: (connId, payload) => {
                socket.send(encodePreviewFrame(connId, PREVIEW_DATA, sealPreviewPayload(payload, clientToHost)));
            },
            drain: () => inbox.splice(0, inbox.length),
            close: () => socket.close(),
        }));
        socket.on('error', reject);
    });
}

function findHeadEnd(bytes: Uint8Array): number {
    const byte = (index: number): number => bytes[index] ?? -1;
    for (let index = 0; index + 4 <= bytes.length; index += 1) {
        if (byte(index) === 13 && byte(index + 1) === 10 && byte(index + 2) === 13 && byte(index + 3) === 10) {
            return index + 4;
        }
    }
    return -1;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

function maskedTextFrame(text: string): Uint8Array {
    const body = new TextEncoder().encode(text);
    if (body.length > 125) throw new Error('selfCheck input is too large');
    const out = new Uint8Array(2 + 4 + body.length);
    const mask = [1, 2, 3, 4];
    out[0] = 0x81;
    out[1] = 0x80 | body.length;
    out.set(mask, 2);
    for (let index = 0; index < body.length; index += 1) {
        out[6 + index] = (body[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    return out;
}

/** Parses server frames; returns complete text messages, ignoring the rest. */
function parseServerTexts(bytes: Uint8Array): string[] {
    const byte = (index: number): number => bytes[index] ?? 0;
    const texts: string[] = [];
    let offset = 0;
    while (offset + 2 <= bytes.length) {
        const opcode = byte(offset) & 0x0f;
        let length = byte(offset + 1) & 0x7f;
        let headLength = 2;
        if (length === 126) {
            if (offset + 4 > bytes.length) break;
            length = (byte(offset + 2) << 8) | byte(offset + 3);
            headLength = 4;
        } else if (length === 127) break;
        if (offset + headLength + length > bytes.length) break;
        if (opcode === 0x1) texts.push(new TextDecoder().decode(bytes.subarray(offset + headLength, offset + headLength + length)));
        offset += headLength + length;
    }
    return texts;
}

async function handshake(client: TestClient, connId: number): Promise<Uint8Array> {
    // Exactly 16 bytes when decoded: servers reject the upgrade otherwise.
    const key = Buffer.from('0123456789abcdef').toString('base64');
    client.sendRaw(connId, new TextEncoder().encode(
        `GET / HTTP/1.1\r\nHost: takeover\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ));
    const parts: Uint8Array[] = [];
    const start = Date.now();
    for (;;) {
        for (const plain of client.drain()) parts.push(plain);
        const bytes = concatBytes(parts);
        const end = findHeadEnd(bytes);
        if (end !== -1) return bytes.subarray(end);
        if (Date.now() - start > 5_000) throw new Error('takeover handshake stalled');
        await delay(5);
    }
}

async function waitFor(label: string, ready: () => boolean): Promise<void> {
    const start = Date.now();
    while (!ready()) {
        if (Date.now() - start > 5_000) throw new Error(`takeover stalled: ${label}`);
        await delay(5);
    }
}

async function runSelfCheck(): Promise<void> {
    const relay = await startFakeRelay();
    const stream = await startStreamServer();
    const ports = { relayUrl: relay.url, machineId: MACHINE, attach: attachPreview };
    const keyA = newPreviewKey();
    const keyB = newPreviewKey();
    const keyC = newPreviewKey();

    // First controller claims the port.
    const first = await openPreview(ports, { channel: 'channel-control-a', port: stream.port, key: keyA, mode: 'control' });
    assert(first.ok, 'first controller attaches');
    const clientA = await openTestClient(relay.url, 'channel-control-a', keyA);

    // A second controller on the same port is rejected host-side.
    const second = await openPreview(ports, { channel: 'channel-control-b', port: stream.port, key: keyB, mode: 'control' });
    assert(!second.ok, 'second controller is rejected');
    assert.match(second.error, /controlled by another device/, 'rejection names the conflict');

    // A watcher may still attach and render frames.
    const watching = await openPreview(ports, { channel: 'channel-observe-c', port: stream.port, key: keyC, mode: 'observe' });
    assert(watching.ok, 'watcher attaches');
    const clientC = await openTestClient(relay.url, 'channel-observe-c', keyC);

    const partsC: Uint8Array[] = [];
    await handshake(clientA, 1);
    const restC = await handshake(clientC, 1);
    partsC.push(restC);
    await waitFor('watcher frames', () => {
        for (const plain of clientC.drain()) partsC.push(plain);
        return parseServerTexts(concatBytes(partsC)).length >= 1;
    });
    const framesC = parseServerTexts(concatBytes(partsC));
    assert.match(framesC[0] ?? '', /"type":"frame"/, 'watcher frame is stream JSON');

    // Watcher input never reaches the stream; controller input does.
    clientC.sendRaw(1, maskedTextFrame(JSON.stringify({ type: 'input_touch', eventType: 'touchStart' })));
    clientA.sendRaw(1, maskedTextFrame(JSON.stringify({ type: 'input_touch', eventType: 'touchStart', touchPoints: [{ x: 1, y: 2 }] })));
    await waitFor('controller input', () => stream.received.length >= 1);
    await delay(200);
    assert.equal(stream.received.length, 1, 'only controller input reaches the stream');
    assert.match(stream.received[0] ?? '', /"x":1/, 'controller input arrives intact');

    // Closing the controller frees the port for the next device: the relay
    // tears down the pair, the host releases the holder, and a new claim wins.
    clientA.close();
    const start = Date.now();
    let third = await openPreview(ports, { channel: 'channel-control-d', port: stream.port, key: keyB, mode: 'control' });
    while (!third.ok && Date.now() - start < 5_000) {
        await delay(50);
        third = await openPreview(ports, { channel: 'channel-control-d', port: stream.port, key: keyB, mode: 'control' });
    }
    assert(third.ok, 'control re-attaches after the holder goes away');

    // Unmoded dev previews still share a port with no arbitration.
    const plain = await openPreview(ports, { channel: 'channel-plain', port: stream.port });
    assert(plain.ok, 'unmoded attach is unaffected');

    clientC.close();
    relay.close();
    stream.close();
    process.stdout.write('PASS: takeover arbitration selfCheck (control, observe, release)\n');
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
    runSelfCheck().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FAIL: takeover arbitration selfCheck: ${message}\n`);
        process.exitCode = 1;
    });
}
