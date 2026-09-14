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
import { deriveV2Key, openPreviewPayload, sealPreviewPayload } from '@muxr/crypto';
import {
    decodePreviewFrame,
    encodePreviewFrame,
    previewSocketUrl,
    PREVIEW_CLOSE,
    PREVIEW_DATA,
    issueWsTicket,
    ticketSocketUrl,
} from '@muxr/contract';
import { ticketWsCredential } from '../../machine/index.js';

const PROBE_TIMEOUT_MS = 1200;
const ATTACH_TIMEOUT_MS = 10_000;
/**
 * Conservative transport ceilings. A browser opens a handful of connections
 * per origin; a leased surface never needs more than this, and a device that
 * churns connection ids is refused rather than buffered.
 */
const MAX_CONNECTIONS = 64;
/** Pause upstream reads while this much is queued on the relay socket. */
const SOCKET_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const SOCKET_LOW_WATER_BYTES = 1 * 1024 * 1024;
const DRAIN_POLL_MS = 25;
/** Observe-mode bounds: handshake heads are small, client frames stay small. */
const OBSERVE_SCAN_BYTES = 16 * 1024;
const OBSERVE_FRAME_BYTES = 1024 * 1024;

function headEnd(bytes: Uint8Array): number {
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

interface ObservedState {
    framed: boolean;
    scan: Uint8Array[];
    scanBytes: number;
    pending: Uint8Array[];
    pendingBytes: number;
}

/**
 * Observe-mode client bytes: the slices to forward, or undefined to kill the
 * connection fail-closed. Before the upstream 101 the bytes are the HTTP
 * upgrade and pass through; after, only control frames (ping/pong/close)
 * pass and data frames are dropped -- a watcher receives stream frames but
 * can never mutate the stream.
 */
function filterObserveBytes(state: ObservedState, plain: Uint8Array): { write: Uint8Array[] } | undefined {
    if (!state.framed) return { write: [plain] };
    state.pending.push(plain);
    state.pendingBytes += plain.length;
    if (state.pendingBytes > OBSERVE_FRAME_BYTES) return undefined;
    const bytes = concatBytes(state.pending);
    const out: Uint8Array[] = [];
    // Every read below is guarded by the loop condition or an explicit break,
    // so `?? 0` never fires on a well-formed buffer; it only keeps the
    // strict index signature satisfied.
    const byte = (index: number): number => bytes[index] ?? 0;
    let offset = 0;
    while (offset + 2 <= bytes.length) {
        const fin = (byte(offset) & 0x80) !== 0;
        const opcode = byte(offset) & 0x0f;
        const masked = (byte(offset + 1) & 0x80) !== 0;
        if ((byte(offset) & 0x70) !== 0 || !masked) return undefined;
        let length = byte(offset + 1) & 0x7f;
        let headLength = 2;
        if (length === 126) {
            if (offset + 4 > bytes.length) break;
            length = (byte(offset + 2) << 8) | byte(offset + 3);
            headLength = 4;
        } else if (length === 127) {
            if (offset + 10 > bytes.length) break;
            const high = byte(offset + 2) * 0x1000000 + byte(offset + 3) * 0x10000
                + byte(offset + 4) * 0x100 + byte(offset + 5);
            const low = (byte(offset + 6) * 0x1000000 + byte(offset + 7) * 0x10000
                + byte(offset + 8) * 0x100 + byte(offset + 9)) >>> 0;
            if (high !== 0 || low > OBSERVE_FRAME_BYTES) return undefined;
            length = low;
            headLength = 10;
        }
        if (opcode >= 0x8 && (!fin || length > 125)) return undefined;
        if (offset + headLength + 4 + length > bytes.length) {
            if (headLength + 4 + length > OBSERVE_FRAME_BYTES) return undefined;
            break;
        }
        const end = offset + headLength + 4 + length;
        if (opcode >= 0x8) out.push(bytes.subarray(offset, end));
        offset = end;
    }
    const rest = bytes.subarray(offset);
    state.pending = rest.length === 0 ? [] : [rest.slice()];
    state.pendingBytes = rest.length;
    return { write: out };
}

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
    key?: string;
    mode?: 'observe' | 'control';
    token?: string;
    onChannelClose?: (channel: string) => void;
    /**
     * Re-read before every new upstream dial. A leased surface passes its
     * live standing here, so a revoked device or an ended lease opens no
     * further connections even before the sweep closes the tunnel.
     */
    authorize?: () => boolean;
}

/**
 * Join `channel` and forward it to `port`. Resolves once the relay socket is
 * open, so a failure to reach the relay surfaces as a failed request instead of
 * a preview that silently never loads. The returned closer ends the tunnel and
 * every connection under it; a lease holds it so revocation closes live
 * connections, not only new dials.
 */
export async function attachPreview(options: AttachPreviewOptions): Promise<() => void> {
    const credential = ticketWsCredential(options.token);
    let socketUrl: string;
    if (credential === undefined) {
        socketUrl = previewSocketUrl(options.relayUrl, {
            machineId: options.machineId,
            channel: options.channel,
            role: 'machine',
            ...(options.token === undefined ? {} : { token: options.token }),
        });
    } else {
        socketUrl = ticketSocketUrl(options.relayUrl, await issueWsTicket({
            relayUrl: options.relayUrl,
            credential,
            machineId: options.machineId,
            role: 'machine',
            transport: 'preview',
            channel: options.channel,
        }), 'preview');
    }
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
    const hostToClientKey = options.key === undefined ? undefined : deriveV2Key(options.key, 'host->client');
    const clientToHostKey = options.key === undefined ? undefined : deriveV2Key(options.key, 'client->host');
    const observing = options.mode === 'observe';
    // Observe-mode connections: pass the HTTP upgrade through, then forward
    // only WebSocket control frames (ping/pong/close) and drop data frames,
    // so a watcher receives frames but can never mutate the stream.
    const observed = new Map<number, ObservedState>();

    const send = (connId: number, flag: number, payload?: Uint8Array): void => {
        if (socket.readyState === WebSocket.OPEN) {
            const body = payload === undefined || hostToClientKey === undefined
                ? payload
                : sealPreviewPayload(payload, hostToClientKey);
            socket.send(encodePreviewFrame(connId, flag, body));
        }
    };

    const drop = (connId: number): void => {
        const existing = connections.get(connId);
        if (existing === undefined) return;
        connections.delete(connId);
        observed.delete(connId);
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
            // Standing is re-read before every dial, and the connection table
            // is bounded: neither a revoked device nor a churning one reaches
            // the dev server again.
            if (connections.size >= MAX_CONNECTIONS || options.authorize?.() === false) {
                send(frame.connId, PREVIEW_CLOSE);
                return;
            }
            // The device opened a new TCP connection; mirror it against the dev
            // server. Writes before connect land in node's own socket buffer.
            upstream = connect(options.port, '127.0.0.1');
            connections.set(frame.connId, upstream);
            if (observing) {
                observed.set(frame.connId, { framed: false, scan: [], scanBytes: 0, pending: [], pendingBytes: 0 });
            }
            const dialed = upstream;
            // Backpressure toward the dev server: while the relay socket holds
            // more than the high-water mark, stop reading this upstream until
            // it drains. Nothing is dropped; the sender simply waits.
            upstream.on('data', (chunk: Buffer) => {
                send(frame.connId, PREVIEW_DATA, new Uint8Array(chunk));
                if (socket.bufferedAmount > SOCKET_HIGH_WATER_BYTES && !dialed.isPaused()) {
                    dialed.pause();
                    const timer = setInterval(() => {
                        if (dialed.destroyed || socket.readyState !== WebSocket.OPEN) {
                            clearInterval(timer);
                            return;
                        }
                        if (socket.bufferedAmount > SOCKET_LOW_WATER_BYTES) return;
                        clearInterval(timer);
                        dialed.resume();
                    }, DRAIN_POLL_MS);
                    timer.unref?.();
                }
                if (observing) {
                    const state = observed.get(frame.connId);
                    if (state !== undefined && !state.framed) {
                        state.scan.push(new Uint8Array(chunk));
                        state.scanBytes += chunk.length;
                        if (state.scanBytes > OBSERVE_SCAN_BYTES) {
                            drop(frame.connId);
                            send(frame.connId, PREVIEW_CLOSE);
                            return;
                        }
                        if (headEnd(concatBytes(state.scan)) !== -1) {
                            state.framed = true;
                            state.scan = [];
                            state.scanBytes = 0;
                        }
                    }
                }
            });
            upstream.on('close', () => {
                connections.delete(frame.connId);
                observed.delete(frame.connId);
                send(frame.connId, PREVIEW_CLOSE);
            });
            upstream.on('error', (error) => {
                process.stderr.write(`preview: upstream ${options.port} failed: ${error.message}\n`);
                connections.delete(frame.connId);
                observed.delete(frame.connId);
                send(frame.connId, PREVIEW_CLOSE);
            });
        }
        if (frame.payload.length > 0) {
            let plain: Uint8Array;
            try {
                plain = clientToHostKey === undefined
                    ? frame.payload
                    : openPreviewPayload(frame.payload, clientToHostKey);
            } catch (error) {
                process.stderr.write(`preview: rejected client frame: ${error instanceof Error ? error.message : String(error)}\n`);
                drop(frame.connId);
                send(frame.connId, PREVIEW_CLOSE);
                return;
            }
            if (observing) {
                const state = observed.get(frame.connId);
                const filtered = state === undefined ? undefined : filterObserveBytes(state, plain);
                if (filtered === undefined) {
                    drop(frame.connId);
                    send(frame.connId, PREVIEW_CLOSE);
                    return;
                }
                for (const slice of filtered.write) upstream.write(slice);
                return;
            }
            upstream.write(plain);
        }
    });

    // The relay closes this side when the device goes away. Without the sweep
    // every dev-server connection from this preview would leak. Releasing the
    // channel also frees takeover control for the next device.
    let ended = false;
    const teardown = (): void => {
        if (ended) return;
        ended = true;
        for (const connId of [...connections.keys()]) drop(connId);
        options.onChannelClose?.(options.channel);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    return () => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        teardown();
    };
}
