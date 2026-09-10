/**
 * A WebSocket client that rides the preview multiplex instead of TCP.
 *
 * The agent-browser stream server speaks plain WebSocket on the host
 * loopback, and the host mirrors any unknown preview connection against the
 * attached port -- so the page performs the upgrade and the frames itself:
 * author masked client frames, parse server frames, answer pings. The relay
 * still blind-copies sealed frames and the host still dials only the
 * attached port, so no relay, host, or protocol change is involved.
 *
 * Bounded like the HTTP bridge: origin-form target, text only (the stream
 * protocol is JSON), 8 MB message cap, every connect timed out, and the
 * connection closed server-side when either end hangs up.
 */

import { encodeBase64 } from '@/encryption/base64';

export interface WsFrameChannel {
    send: (connId: number, closed: boolean, payload?: Uint8Array) => void;
    onFrame: (handler: (frame: { connId: number; closed: boolean; payload: Uint8Array }) => void) => void;
}

export interface TakeoverWs {
    connect: () => Promise<void>;
    sendText: (text: string) => void;
    onText: (handler: (text: string) => void) => void;
    onClose: (handler: () => void) => void;
    close: () => void;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
const TAKEOVER_CONN_ID = 1;

/** Compact SHA-1 for the upgrade accept check; verified against RFC 6455 vectors. */
export function sha1(message: Uint8Array): Uint8Array {
    const bitLengthHigh = Math.floor(message.length / 0x20000000);
    const bitLengthLow = (message.length << 3) >>> 0;
    const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, bitLengthHigh);
    view.setUint32(paddedLength - 4, bitLengthLow);
    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;
    const schedule = new Uint32Array(80);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
        for (let index = 16; index < 80; index += 1) {
            const value = schedule[index - 3] ^ schedule[index - 8] ^ schedule[index - 14] ^ schedule[index - 16];
            schedule[index] = ((value << 1) | (value >>> 31)) >>> 0;
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        for (let index = 0; index < 80; index += 1) {
            let f: number;
            let k: number;
            if (index < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
            else if (index < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
            else if (index < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; k = 0xca62c1d6; }
            const rotated = (((a << 5) | (a >>> 27)) >>> 0);
            const temp = (rotated + (f >>> 0) + e + k + schedule[index]) >>> 0;
            e = d;
            d = c;
            c = ((b << 30) | (b >>> 2)) >>> 0;
            b = a;
            a = temp >>> 0;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, h0);
    outView.setUint32(4, h1);
    outView.setUint32(8, h2);
    outView.setUint32(12, h3);
    outView.setUint32(16, h4);
    return out;
}

export function websocketAccept(key: string): string {
    return encodeBase64(sha1(new TextEncoder().encode(`${key}${WS_GUID}`)));
}

function randomKeyBytes(): Uint8Array {
    const bytes = new Uint8Array(16);
    const cryptoObject = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => void } }).crypto;
    if (cryptoObject?.getRandomValues !== undefined) {
        cryptoObject.getRandomValues(bytes);
        return bytes;
    }
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    return bytes;
}

/** Client frames are always masked; the mask itself need not be secret. */
function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
    if (payload.length > MAX_WS_MESSAGE_BYTES) throw new Error('Takeover message is too large.');
    const headLength = payload.length <= 125 ? 2 : payload.length <= 65_535 ? 4 : 10;
    const out = new Uint8Array(headLength + 4 + payload.length);
    out[0] = 0x80 | opcode;
    const mask = randomKeyBytes().subarray(0, 4);
    if (payload.length <= 125) {
        out[1] = 0x80 | payload.length;
    } else if (payload.length <= 65_535) {
        out[1] = 0x80 | 126;
        out[2] = (payload.length >>> 8) & 0xff;
        out[3] = payload.length & 0xff;
    } else {
        out[1] = 0x80 | 127;
        // High 32 bits are zero: the cap above keeps lengths in 32 bits.
        out[2] = 0; out[3] = 0; out[4] = 0; out[5] = 0;
        out[6] = (payload.length >>> 24) & 0xff;
        out[7] = (payload.length >>> 16) & 0xff;
        out[8] = (payload.length >>> 8) & 0xff;
        out[9] = payload.length & 0xff;
    }
    out.set(mask, headLength);
    for (let index = 0; index < payload.length; index += 1) {
        out[headLength + 4 + index] = payload[index] ^ mask[index % 4];
    }
    return out;
}

function findHeadEnd(bytes: Uint8Array): number {
    for (let index = 0; index + 4 <= bytes.length; index += 1) {
        if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
            return index + 4;
        }
    }
    return -1;
}

function concat(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

interface FrameEvents {
    text: (text: string) => void;
    ping: (payload: Uint8Array) => void;
    close: () => void;
}

/** Incremental server-frame parser; throws on protocol violations. */
class WsParser {
    private buffered: Uint8Array[] = [];
    private bufferedBytes = 0;
    private fragments: Uint8Array[] = [];
    private fragmentBytes = 0;
    private fragmenting = false;

    feed(data: Uint8Array, events: FrameEvents): void {
        this.buffered.push(data);
        this.bufferedBytes += data.length;
        for (;;) {
            const bytes = concat(this.buffered);
            if (bytes.length < 2) return;
            const fin = (bytes[0] & 0x80) !== 0;
            const opcode = bytes[0] & 0x0f;
            const masked = (bytes[1] & 0x80) !== 0;
            if ((bytes[0] & 0x70) !== 0) throw new Error('Takeover stream uses an extension.');
            if (masked) throw new Error('Takeover stream masked a server frame.');
            let length = bytes[1] & 0x7f;
            let headLength = 2;
            if (length === 126) {
                if (bytes.length < 4) return;
                length = (bytes[2] << 8) | bytes[3];
                headLength = 4;
            } else if (length === 127) {
                if (bytes.length < 10) return;
                const high = (bytes[2] * 0x1000000 + bytes[3] * 0x10000 + bytes[4] * 0x100 + bytes[5]);
                const low = (bytes[6] * 0x1000000 + bytes[7] * 0x10000 + bytes[8] * 0x100 + bytes[9]) >>> 0;
                if (high !== 0 || low > MAX_WS_MESSAGE_BYTES) throw new Error('Takeover message is too large.');
                length = low;
                headLength = 10;
            }
            if (opcode >= 0x8 && (!fin || length > 125)) throw new Error('Takeover stream sent a bad control frame.');
            if (bytes.length < headLength + length) {
                if (headLength + length > MAX_WS_MESSAGE_BYTES + headLength) throw new Error('Takeover message is too large.');
                return;
            }
            const payload = bytes.subarray(headLength, headLength + length);
            this.buffered = bytes.length > headLength + length ? [bytes.subarray(headLength + length)] : [];
            this.bufferedBytes = this.buffered.length === 0 ? 0 : this.buffered[0]?.length ?? 0;
            if (opcode === 0x8) {
                events.close();
                return;
            }
            if (opcode === 0x9) {
                events.ping(payload.slice());
                continue;
            }
            if (opcode === 0xa) continue;
            if (opcode === 0x2) continue; // Binary is not the stream protocol; ignore it.
            if (opcode === 0x1) {
                if (this.fragmenting) throw new Error('Takeover stream interleaved messages.');
                if (fin) {
                    events.text(new TextDecoder('utf-8', { fatal: true }).decode(payload));
                } else {
                    this.fragmenting = true;
                    this.fragments = [payload.slice()];
                    this.fragmentBytes = payload.length;
                }
                continue;
            }
            if (opcode === 0x0) {
                if (!this.fragmenting) throw new Error('Takeover stream sent a stray fragment.');
                if (this.fragmentBytes + payload.length > MAX_WS_MESSAGE_BYTES) {
                    throw new Error('Takeover message is too large.');
                }
                this.fragments.push(payload.slice());
                this.fragmentBytes += payload.length;
                if (fin) {
                    this.fragmenting = false;
                    events.text(new TextDecoder('utf-8', { fatal: true }).decode(concat(this.fragments)));
                    this.fragments = [];
                    this.fragmentBytes = 0;
                }
                continue;
            }
            throw new Error('Takeover stream sent an unknown frame.');
        }
    }
}

export function createTakeoverWs(channel: WsFrameChannel, options?: { target?: string }): TakeoverWs {
    const target = options?.target ?? '/';
    if (!target.startsWith('/')) throw new Error('Takeover target must be an origin-form path.');
    const parser = new WsParser();
    let textHandler: ((text: string) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    let handshakeBytes: Uint8Array[] | undefined;
    let connected = false;
    let closed = false;

    const reportClose = (): void => {
        if (closed) return;
        closed = true;
        closeHandler?.();
    };

    const pong = (payload: Uint8Array): void => {
        if (!closed) channel.send(TAKEOVER_CONN_ID, false, encodeFrame(0xa, payload));
    };

    // One dispatcher for the life of the channel: while a handshake is in
    // flight bytes accumulate for it, afterwards they feed the frame parser.
    let handshakeHandler: ((frame: { connId: number; closed: boolean; payload: Uint8Array }) => void) | undefined;
    channel.onFrame((frame) => {
        if (frame.connId !== TAKEOVER_CONN_ID) return;
        if (handshakeBytes !== undefined && handshakeHandler !== undefined) {
            handshakeHandler(frame);
            return;
        }
        if (handshakeBytes !== undefined || textHandler === undefined) return;
        if (frame.closed) {
            reportClose();
            return;
        }
        try {
            parser.feed(frame.payload, {
                text: (text) => textHandler?.(text),
                ping: (payload) => pong(payload),
                close: () => {
                    channel.send(TAKEOVER_CONN_ID, true);
                    reportClose();
                },
            });
        } catch {
            channel.send(TAKEOVER_CONN_ID, true);
            reportClose();
        }
    });

    const ws: TakeoverWs = {
        connect: () => new Promise<void>((resolve, reject) => {
            const key = encodeBase64(randomKeyBytes());
            const expected = websocketAccept(key);
            const head =
                `GET ${target} HTTP/1.1\r\nHost: takeover\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
            handshakeBytes = [];
            const timer = setTimeout(() => {
                handshakeBytes = undefined;
                handshakeHandler = undefined;
                channel.send(TAKEOVER_CONN_ID, true);
                reject(new Error('The takeover stream did not answer.'));
            }, CONNECT_TIMEOUT_MS);
            const finish = (error?: Error): void => {
                clearTimeout(timer);
                handshakeBytes = undefined;
                handshakeHandler = undefined;
                if (error !== undefined) {
                    channel.send(TAKEOVER_CONN_ID, true);
                    reject(error);
                } else {
                    connected = true;
                    resolve();
                }
            };
            handshakeHandler = (frame): void => {
                if (frame.closed) {
                    finish(new Error('The takeover stream closed.'));
                    return;
                }
                handshakeBytes?.push(frame.payload);
                const bytes = concat(handshakeBytes ?? []);
                const end = findHeadEnd(bytes);
                if (end === -1) {
                    if (bytes.length > 16 * 1024) finish(new Error('The takeover stream handshake is too large.'));
                    return;
                }
                const lines = new TextDecoder().decode(bytes.subarray(0, end)).split('\r\n');
                const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? '');
                if (status === null || status[1] !== '101') {
                    finish(new Error(`The takeover stream refused the connection${status === null ? '' : ` (${status[1]})`}.`));
                    return;
                }
                const headers = new Map<string, string>();
                for (const line of lines.slice(1)) {
                    const colon = line.indexOf(':');
                    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
                }
                if (headers.get('sec-websocket-accept') !== expected) {
                    finish(new Error('The takeover stream handshake failed.'));
                    return;
                }
                const rest = bytes.subarray(end);
                if (rest.length > 0) {
                    try {
                        parser.feed(rest, {
                            text: (text) => textHandler?.(text),
                            ping: (payload) => pong(payload),
                            close: () => reportClose(),
                        });
                    } catch {
                        finish(new Error('The takeover stream sent a bad frame.'));
                        return;
                    }
                }
                finish();
            };
            try {
                channel.send(TAKEOVER_CONN_ID, false, new TextEncoder().encode(head));
            } catch (error) {
                clearTimeout(timer);
                handshakeBytes = undefined;
                handshakeHandler = undefined;
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        }),

        sendText: (text) => {
            if (!connected || closed) throw new Error('The takeover stream is closed.');
            channel.send(TAKEOVER_CONN_ID, false, encodeFrame(0x1, new TextEncoder().encode(text)));
        },

        onText: (handler) => { textHandler = handler; },
        onClose: (handler) => { closeHandler = handler; },

        close: () => {
            if (closed) return;
            closed = true;
            try {
                channel.send(TAKEOVER_CONN_ID, false, encodeFrame(0x8, new Uint8Array([0x03, 0xe8])));
            } catch { /* already gone */ }
            channel.send(TAKEOVER_CONN_ID, true);
        },
    };
    return ws;
}
