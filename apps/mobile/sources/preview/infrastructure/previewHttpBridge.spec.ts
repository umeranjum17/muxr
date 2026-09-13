/**
 * Web preview bridge flow: the page authors HTTP over the sealed preview
 * multiplex and a real loopback app answers. The host half here mirrors the
 * production byte pipe (`attachPreview`: unknown connection -> dial 127.0.0.1,
 * pipe bytes, close on error), so what the app observes -- method, target,
 * and crucially the *absence* of the tab's cookies -- is what the real host
 * would observe.
 */

import { connect, type Socket } from 'node:net';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { deriveV2Key, newPreviewKey, openPreviewPayload, sealPreviewPayload } from '@muxr/crypto';
import { decodePreviewFrame, encodePreviewFrame, PREVIEW_CLOSE, PREVIEW_DATA } from '@muxr/contract';
import { createPreviewHttpBridge } from './previewHttpBridge';

interface ObservedRequest {
    method: string;
    url: string;
    cookie: string | undefined;
    body: string;
}

/** Production host behavior in miniature: seal/open + dial + pipe + close. */
function createHostPipe(port: number, key: string) {
    const clientToHostKey = deriveV2Key(key, 'client->host');
    const hostToClientKey = deriveV2Key(key, 'host->client');
    const connections = new Map<number, Socket>();
    const outbox: Uint8Array[] = [];
    let dials = 0;

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
            dials += 1;
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
        dials: (): number => dials,
        open: (): number => connections.size,
    };
}

async function settle<T>(attempt: Promise<T>, host: ReturnType<typeof createHostPipe>, bridge: { handleSocketBytes: (data: Uint8Array) => void }): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    attempt.then(
        (resolved) => { done = true; value = resolved; },
        (rejected: unknown) => { done = true; error = rejected; },
    );
    const start = Date.now();
    while (!done) {
        for (const frame of host.drain()) bridge.handleSocketBytes(frame);
        if (!done) {
            if (Date.now() - start > 5_000) throw new Error('preview round trip stalled');
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    if (error !== undefined) throw error;
    return value as T;
}

describe('preview HTTP bridge', () => {
    it('serves the app document through the sealed channel without cookies either way', async () => {
        const observed: ObservedRequest[] = [];
        const server = http.createServer((request, response) => {
            let body = '';
            request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            request.on('end', () => {
                observed.push({
                    method: request.method ?? '',
                    url: request.url ?? '',
                    cookie: request.headers.cookie,
                    body,
                });
                if (request.url === '/chunked') {
                    response.writeHead(200, { 'content-type': 'text/plain' });
                    response.write('one-');
                    response.end('two');
                    return;
                }
                if (request.url === '/echo') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(body);
                    return;
                }
                response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sess=host-only' });
                response.end('<h1>hi</h1>');
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        try {
            const key = newPreviewKey();
            const host = createHostPipe(port, key);
            const bridge = createPreviewHttpBridge({ key, sendBinary: (bytes) => host.receive(bytes) });

            const document = await settle(bridge.request('/', { method: 'GET', headers: [['Accept', 'text/html']] }), host, bridge);
            expect(document.status).toBe(200);
            expect(new TextDecoder().decode(document.body)).toBe('<h1>hi</h1>');
            // The app's session cookie stays on the host loopback: never stored here.
            expect(document.headers.some(([name]) => name.toLowerCase() === 'set-cookie')).toBe(false);
            expect(observed[0]).toMatchObject({ method: 'GET', url: '/' });

            const echo = await settle(
                bridge.request('/echo', {
                    method: 'POST',
                    headers: [['Content-Type', 'application/json'], ['Cookie', 'tab=stolen']],
                    body: new TextEncoder().encode('{"tap":1}'),
                }),
                host,
                bridge,
            );
            expect(echo.status).toBe(200);
            expect(new TextDecoder().decode(echo.body)).toBe('{"tap":1}');
            // The tab's cookies never reach the dev server, even when offered.
            expect(observed[1]).toMatchObject({ method: 'POST', url: '/echo', cookie: undefined, body: '{"tap":1}' });

            const chunked = await settle(bridge.request('/chunked', { method: 'GET', headers: [] }), host, bridge);
            expect(new TextDecoder().decode(chunked.body)).toBe('one-two');

            expect(host.open()).toBe(0);
        } finally {
            server.close();
        }
    });

    it('rejects non-HTTP targets and dead servers without leaking connections', async () => {
        const key = newPreviewKey();
        const host = createHostPipe(1, key);
        const bridge = createPreviewHttpBridge({ key, sendBinary: (bytes) => host.receive(bytes) });

        await expect(bridge.request('http://127.0.0.1:80/', { method: 'GET', headers: [] })).rejects.toThrow(
            'origin-form',
        );
        await expect(bridge.request('/', { method: 'TRACE', headers: [] })).rejects.toThrow('does not forward');
        expect(host.dials()).toBe(0);

        await expect(settle(bridge.request('/', { method: 'GET', headers: [] }), host, bridge)).rejects.toThrow();
        expect(host.open()).toBe(0);
        bridge.close();
    });
});
