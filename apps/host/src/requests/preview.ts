/**
 * Browser preview, machine half.
 *
 * `probePreviewPort` answers what a loopback port speaks, so the phone can
 * tell a web app (Preview) from a JSON API (Open). `attachPreview` joins a
 * relay preview channel and dials the chosen port on this machine's own
 * loopback, so a dev server bound to 127.0.0.1 needs no rebinding and is
 * never exposed to the network -- the only thing that leaves the machine is
 * the relay socket the host already holds open.
 */

import { connect, type Socket } from 'node:net';
import WebSocket from 'ws';
import {
    decodePreviewFrame,
    encodePreviewFrame,
    previewSocketUrl,
    PREVIEW_CLOSE,
    PREVIEW_DATA,
    issueWsTicket,
    ticketSocketUrl,
} from '@muxr/contract';

const PROBE_TIMEOUT_MS = 1200;
const ATTACH_TIMEOUT_MS = 10_000;

/**
 * The content-type the port answers with, or null when nothing HTTP listens
 * there. GET, not HEAD: some servers 405 a HEAD and a web app would be
 * misread as an API. The body is dropped unread -- the header is the answer.
 */
export async function probePreviewPort(port: number): Promise<string | null> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        void response.body?.cancel();
        return response.headers.get('content-type');
    } catch {
        return null;
    }
}

export interface AttachPreviewOptions {
    relayUrl: string;
    machineId: string;
    channel: string;
    port: number;
    token?: string;
}

/**
 * Join `channel` and forward it to `port`. Resolves once the relay socket is
 * open, so a failure to reach the relay surfaces as a failed request instead of
 * a preview that silently never loads.
 */
export async function attachPreview(options: AttachPreviewOptions): Promise<null> {
    const socketUrl = options.token === undefined || options.token.startsWith('machinetok_')
        ? previewSocketUrl(options.relayUrl, {
            machineId: options.machineId,
            channel: options.channel,
            role: 'machine',
            ...(options.token === undefined ? {} : { token: options.token }),
        })
        : ticketSocketUrl(options.relayUrl, await issueWsTicket({
            relayUrl: options.relayUrl,
            credential: options.token,
            machineId: options.machineId,
            role: 'machine',
            transport: 'preview',
            channel: options.channel,
        }), 'preview');
    const socket = new WebSocket(socketUrl);
    socket.binaryType = 'nodebuffer';

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`preview: relay did not accept the channel within ${ATTACH_TIMEOUT_MS}ms`));
        }, ATTACH_TIMEOUT_MS);
        socket.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('error', (error: Error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

    const connections = new Map<number, Socket>();

    const send = (connId: number, flag: number, payload?: Uint8Array): void => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(encodePreviewFrame(connId, flag, payload));
        }
    };

    const drop = (connId: number): void => {
        const existing = connections.get(connId);
        if (existing === undefined) return;
        connections.delete(connId);
        existing.destroy();
    };

    socket.on('message', (raw: Buffer) => {
        const frame = decodePreviewFrame(new Uint8Array(raw));
        if (frame === undefined) return;

        if (frame.flag === PREVIEW_CLOSE) {
            drop(frame.connId);
            return;
        }

        let upstream = connections.get(frame.connId);
        if (upstream === undefined) {
            // The device opened a new TCP connection; mirror it against the dev
            // server. Writes before connect land in node's own socket buffer.
            upstream = connect(options.port, '127.0.0.1');
            connections.set(frame.connId, upstream);
            // ponytail: no backpressure. A large bundle buffers in ws until it
            // drains. Pause the socket on socket.bufferedAmount if it bites.
            upstream.on('data', (chunk: Buffer) => send(frame.connId, PREVIEW_DATA, new Uint8Array(chunk)));
            upstream.on('close', () => {
                connections.delete(frame.connId);
                send(frame.connId, PREVIEW_CLOSE);
            });
            upstream.on('error', () => {
                connections.delete(frame.connId);
                send(frame.connId, PREVIEW_CLOSE);
            });
        }
        if (frame.payload.length > 0) upstream.write(frame.payload);
    });

    // The relay closes this side when the device goes away. Without the sweep
    // every dev-server connection from this preview would leak.
    const teardown = (): void => {
        for (const connId of [...connections.keys()]) drop(connId);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    return null;
}
