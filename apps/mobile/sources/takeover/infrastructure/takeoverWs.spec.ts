/**
 * Browser takeover flow: the page performs the agent-browser WebSocket over
 * sealed preview frames, with a real `ws` server standing in for the stream
 * binary and a host harness mirroring the production byte pipe (unknown
 * connection -> dial 127.0.0.1, pipe bytes, close on error). What the server
 * observes -- the exact touch/keyboard JSON -- is what the real host would
 * carry, and the frame bytes the page renders arrive sealed end to end.
 */

import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { deriveV2Key, newPreviewKey, openPreviewPayload, sealPreviewPayload } from '@muxr/crypto';
import { decodePreviewFrame, encodePreviewFrame, PREVIEW_CLOSE, PREVIEW_DATA } from '@muxr/contract';
import { createPreviewChannel } from '@/preview/infrastructure/previewChannel';
import { createTakeoverWs, sha1, websocketAccept } from './takeoverWs';

const FRAME_METADATA = {
    deviceWidth: 390,
    deviceHeight: 844,
    pageScaleFactor: 2,
    offsetTop: 0,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
};

function frameMessage(tag: string): string {
    return JSON.stringify({
        type: 'frame',
        data: Buffer.from(tag).toString('base64'),
        metadata: FRAME_METADATA,
    });
}

/** Production host behavior in miniature: seal/open + dial + pipe + close. */
function createHostPipe(port: number, key: string) {
    const clientToHostKey = deriveV2Key(key, 'client->host');
    const hostToClientKey = deriveV2Key(key, 'host->client');
    const connections = new Map<number, Socket>();
    const outbox: Uint8Array[] = [];

    const send = (connId: number, flag: number, payload?: Uint8Array): void => {
        outbox.push(encodePreviewFrame(connId, flag, payload === undefined ? undefined : sealPreviewPayload(payload, hostToClientKey)));
    };

    const receive = (raw: Uint8Array): void => {
        const frame = decodePreviewFrame(raw);
        if (frame === undefined) return;
        if (frame.flag === PREVIEW_CLOSE) {
            connections.get(frame.connId)?.destroy();
            connections.delete(frame.connId);
            return;
        }
        let upstream = connections.get(frame.connId);
        if (upstream === undefined) {
            upstream = connect(port, '127.0.0.1');
            connections.set(frame.connId, upstream);
            const connId = frame.connId;
            upstream.on('data', (chunk: Buffer) => send(connId, PREVIEW_DATA, new Uint8Array(chunk)));
            const finish = (): void => {
                if (connections.get(connId) === upstream) {
                    connections.delete(connId);
                    send(connId, PREVIEW_CLOSE);
                }
            };
            upstream.on('close', finish);
            upstream.on('error', finish);
        }
        if (frame.payload.length > 0) {
            try {
                upstream.write(Buffer.from(openPreviewPayload(frame.payload, clientToHostKey)));
            } catch {
                connections.delete(frame.connId);
                upstream.destroy();
                send(frame.connId, PREVIEW_CLOSE);
            }
        }
    };

    return {
        receive,
        drain: (): Uint8Array[] => outbox.splice(0, outbox.length),
        open: (): number => connections.size,
    };
}

function createSocketPair(host: ReturnType<typeof createHostPipe>) {
    const socket = {
        OPEN: 1 as const,
        readyState: 1,
        binaryType: '',
        onmessage: null as null | ((event: { data: unknown }) => void),
        send: (bytes: Uint8Array) => host.receive(bytes),
        close: () => {},
    };
    const pump = (): void => {
        for (const frame of host.drain()) socket.onmessage?.({ data: frame });
    };
    return { socket, pump };
}

async function settle(pump: () => void, done: () => boolean, label: string): Promise<void> {
    const start = Date.now();
    while (!done()) {
        pump();
        if (!done()) {
            if (Date.now() - start > 5_000) throw new Error(`takeover stalled: ${label}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    pump();
}

describe('browser takeover stream', () => {
    it('shakes hands, renders sealed frames, and delivers exact input', async () => {
        const received: string[] = [];
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise<void>((resolve) => server.on('listening', resolve));
        const port = (server.address() as AddressInfo).port;
        server.on('connection', (ws) => {
            ws.send(frameMessage('jpeg-bytes-1'));
            ws.on('message', (data) => {
                received.push(String(data));
                if (received.length === 1) ws.send(frameMessage('jpeg-bytes-2'));
            });
        });
        try {
            const key = newPreviewKey();
            const host = createHostPipe(port, key);
            const { socket, pump } = createSocketPair(host);
            const channel = createPreviewChannel(socket as unknown as WebSocket, key);
            const takeover = createTakeoverWs(channel);

            const texts: string[] = [];
            let closed = false;
            takeover.onText((text) => texts.push(text));
            takeover.onClose(() => { closed = true; });

            let connected = false;
            void takeover.connect().then(() => { connected = true; });
            await settle(pump, () => connected, 'connect');
            await settle(pump, () => texts.length >= 1, 'first frame');

            // The rendered frame bytes arrive sealed through the whole path.
            const first = JSON.parse(texts[0] ?? '') as { type: string; data: string };
            expect(first.type).toBe('frame');
            expect(Buffer.from(first.data, 'base64').toString()).toBe('jpeg-bytes-1');

            // Input the user sends is what the stream server observes, byte for byte.
            const touch = JSON.stringify({ type: 'input_touch', eventType: 'touchStart', touchPoints: [{ x: 120, y: 300 }] });
            const keys = JSON.stringify({ type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA' });
            takeover.sendText(touch);
            takeover.sendText(keys);
            await settle(pump, () => received.length >= 2 && texts.length >= 2, 'input echo');
            expect(received).toEqual([touch, keys]);
            const second = JSON.parse(texts[1] ?? '') as { data: string };
            expect(Buffer.from(second.data, 'base64').toString()).toBe('jpeg-bytes-2');

            // A server ping is answered, so the stream survives keepalive.
            for (const client of server.clients) client.ping();
            takeover.sendText(touch);
            await settle(pump, () => received.length >= 3, 'post-ping input');
            expect(received[2]).toBe(touch);
            expect(closed).toBe(false);
            expect(host.open()).toBe(1);

            // A tampered payload fails closed instead of reaching the parser.
            const wrongKey = deriveV2Key(newPreviewKey(), 'host->client');
            const tampered = encodePreviewFrame(1, PREVIEW_DATA, sealPreviewPayload(new TextEncoder().encode('x'), wrongKey));
            socket.onmessage?.({ data: tampered });
            await settle(pump, () => closed, 'tamper close');
            expect(closed).toBe(true);
        } finally {
            server.close();
        }
    });

    it('agrees with RFC 6455 on the handshake accept', () => {
        expect(Buffer.from(sha1(new TextEncoder().encode('abc'))).toString('hex')).toBe(
            'a9993e364706816aba3e25717850c26c9cd0d89d',
        );
        expect(websocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    });
});
