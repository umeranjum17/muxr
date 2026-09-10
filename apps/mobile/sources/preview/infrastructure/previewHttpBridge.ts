/**
 * HTTP over the preview multiplex, page half.
 *
 * A browser tab cannot bind the loopback listener the native bridge uses, but
 * the host mirrors any unknown-connection frame against the dev server on its
 * own loopback -- so the page can drive the same channel by authoring HTTP
 * request bytes and parsing the response bytes that come back. No relay, host,
 * or protocol change: frames stay E2EE-sealed PreviewFrames on the `bridge=1`
 * path the relay blind-copies.
 *
 * Bounded on purpose: origin-form targets on the attached port only, a small
 * method allowlist, no ambient credentials in either direction (the browser's
 * cookies never leave the tab, the app's Set-Cookie never enters it -- session
 * state that lives in cookies stays on the host loopback, unreachable here),
 * bodies capped, every request timed out, and the connection closed
 * server-side via `Connection: close` so a response always has an end.
 */

import { deriveV2Key, openPreviewPayload, sealPreviewPayload } from '@muxr/crypto';
import {
    decodePreviewFrame,
    encodePreviewFrame,
    PREVIEW_CLOSE,
    PREVIEW_DATA,
} from '@muxr/contract';

export interface PreviewHttpRequestInit {
    method: string;
    headers: Array<[string, string]>;
    body?: Uint8Array;
}

export interface PreviewHttpResponse {
    status: number;
    headers: Array<[string, string]>;
    body: Uint8Array;
}

export interface PreviewHttpBridge {
    request: (target: string, init: PreviewHttpRequestInit) => Promise<PreviewHttpResponse>;
    handleSocketBytes: (data: Uint8Array) => void;
    close: () => void;
}

/** Browsers cap ~6 connections per origin; the multiplex has no such limit, but stay small. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Never forward the tab's credentials to the dev server, and never store the app's. */
const STRIPPED_REQUEST_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'proxy-authenticate']);

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function checkField(value: string, what: string): void {
    if (value.length === 0 || value.length > 8_192 || /[\r\n\0]/.test(value)) {
        throw new Error(`Preview request has an invalid ${what}.`);
    }
}

function normalizeTarget(target: string): string {
    // Origin-form only: the host dials the attached port, so there is no host
    // to name and no scheme to pick. Queries stay; fragments never leave a
    // client, so drop one rather than forward it.
    if (!target.startsWith('/')) throw new Error('Preview requests must be origin-form paths.');
    const hash = target.indexOf('#');
    const clean = hash === -1 ? target : target.slice(0, hash);
    if (clean.length === 0 || clean.length > 8_192 || /[\r\n\0 ]/.test(clean)) {
        throw new Error('Preview requests must be origin-form paths.');
    }
    return clean;
}

function encodeRequest(target: string, init: PreviewHttpRequestInit): Uint8Array {
    const method = init.method.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw new Error(`Preview does not forward ${init.method}.`);
    const path = normalizeTarget(target);
    const headers: Array<[string, string]> = [];
    for (const [name, value] of init.headers) {
        checkField(name, 'header name');
        checkField(value, 'header value');
        if (!TOKEN.test(name)) throw new Error('Preview request has an invalid header name.');
        if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
        headers.push([name, value]);
    }
    const body = init.body ?? new Uint8Array(0);
    if (body.length > MAX_BODY_BYTES) throw new Error('Preview request body is too large.');
    const head =
        `${method} ${path} HTTP/1.1\r\nHost: preview\r\nConnection: close\r\n` +
        `Content-Length: ${body.length}\r\n` +
        headers.map(([name, value]) => `${name}: ${value}\r\n`).join('') +
        '\r\n';
    const headBytes = new TextEncoder().encode(head);
    const out = new Uint8Array(headBytes.length + body.length);
    out.set(headBytes, 0);
    out.set(body, headBytes.length);
    return out;
}

interface ParsedHead {
    status: number;
    headers: Array<[string, string]>;
    bodyStart: number;
    contentLength: number | undefined;
    chunked: boolean;
}

function parseHead(bytes: Uint8Array): ParsedHead | undefined {
    const end = findHeaderEnd(bytes);
    if (end === -1) return undefined;
    const text = new TextDecoder().decode(bytes.subarray(0, end));
    const lines = text.split('\r\n');
    const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? '');
    if (statusMatch === null) throw new Error('Preview response is not HTTP.');
    const headers: Array<[string, string]> = [];
    let contentLength: number | undefined;
    let chunked = false;
    for (const line of lines.slice(1)) {
        if (line === '') continue;
        const colon = line.indexOf(':');
        if (colon <= 0) throw new Error('Preview response has a bad header.');
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        headers.push([name, value]);
        const lower = name.toLowerCase();
        if (lower === 'content-length' && contentLength === undefined) {
            const parsed = Number(value);
            if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_BODY_BYTES) {
                throw new Error('Preview response has a bad length.');
            }
            contentLength = parsed;
        }
        if (lower === 'transfer-encoding' && value.toLowerCase().includes('chunked')) chunked = true;
    }
    return { status: Number(statusMatch[1]), headers, bodyStart: end, contentLength, chunked };
}

function findHeaderEnd(bytes: Uint8Array): number {
    for (let index = 0; index + 4 <= bytes.length; index += 1) {
        if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
            return index + 4;
        }
    }
    return -1;
}

/** Decode as much of a chunked body as is present; undefined means truncated. */
function decodeChunked(bytes: Uint8Array): { body: Uint8Array; done: boolean } | undefined {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let offset = 0;
    for (;;) {
        const lineEnd = findLineEnd(bytes, offset);
        if (lineEnd === -1) return undefined;
        const sizeText = new TextDecoder().decode(bytes.subarray(offset, lineEnd)).split(';')[0]?.trim() ?? '';
        if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) throw new Error('Preview response has a bad chunk.');
        const size = parseInt(sizeText, 16);
        if (size === 0) {
            // Terminal chunk; trailers (if any) run to the final CRLF.
            const trailerEnd = findHeaderEndFrom(bytes, lineEnd + 2);
            if (trailerEnd === -1) {
                // Bare `0\r\n\r\n` with no trailers: the `0` sits at
                // lineEnd - 1, so the terminator ends at lineEnd + 3.
                if (bytes.length < lineEnd + 4) return undefined;
                if (bytes[lineEnd + 2] !== 13 || bytes[lineEnd + 3] !== 10) throw new Error('Preview response has a bad chunk.');
            }
            const body = new Uint8Array(total);
            let at = 0;
            for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
            return { body, done: true };
        }
        if (total + size > MAX_BODY_BYTES) throw new Error('Preview response is too large.');
        if (bytes.length < lineEnd + 2 + size + 2) return undefined;
        chunks.push(bytes.subarray(lineEnd + 2, lineEnd + 2 + size));
        total += size;
        if (bytes[lineEnd + 2 + size] !== 13 || bytes[lineEnd + 2 + size + 1] !== 10) {
            throw new Error('Preview response has a bad chunk.');
        }
        offset = lineEnd + 2 + size + 2;
    }
}

function findLineEnd(bytes: Uint8Array, from: number): number {
    for (let index = from; index + 1 < bytes.length; index += 1) {
        if (bytes[index] === 13 && bytes[index + 1] === 10) return index;
    }
    return -1;
}

function findHeaderEndFrom(bytes: Uint8Array, from: number): number {
    for (let index = from; index + 4 <= bytes.length; index += 1) {
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

interface PendingRequest {
    resolve: (response: PreviewHttpResponse) => void;
    reject: (error: Error) => void;
    chunks: Uint8Array[];
    received: number;
    head: ParsedHead | undefined;
    timer: ReturnType<typeof setTimeout>;
}

export function createPreviewHttpBridge(options: {
    key: string;
    sendBinary: (bytes: Uint8Array) => void;
}): PreviewHttpBridge {
    const clientToHostKey = deriveV2Key(options.key, 'client->host');
    const hostToClientKey = deriveV2Key(options.key, 'host->client');
    const pending = new Map<number, PendingRequest>();
    let nextConnId = 0;
    let closed = false;

    const fail = (connId: number, error: Error): void => {
        const found = pending.get(connId);
        if (found === undefined) return;
        pending.delete(connId);
        clearTimeout(found.timer);
        found.reject(error);
        sendClose(connId);
    };

    const sendClose = (connId: number): void => {
        if (closed) return;
        try {
            options.sendBinary(encodePreviewFrame(connId, PREVIEW_CLOSE));
        } catch {
            /* socket already gone */
        }
    };

    const finish = (connId: number, entry: PendingRequest, body: Uint8Array): void => {
        pending.delete(connId);
        clearTimeout(entry.timer);
        const headers = entry.head?.headers.filter(([name]) => name.toLowerCase() !== 'set-cookie') ?? [];
        entry.resolve({ status: entry.head?.status ?? 0, headers, body });
        sendClose(connId);
    };

    const absorb = (connId: number, entry: PendingRequest, closedByPeer: boolean): void => {
        try {
            if (entry.head === undefined) {
                const bytes = concat(entry.chunks);
                const head = parseHead(bytes);
                if (head === undefined) {
                    if (bytes.length > 64 * 1024) throw new Error('Preview response head is too large.');
                    if (closedByPeer) throw new Error('Preview closed the response.');
                    return;
                }
                entry.head = head;
            }
            const head = entry.head;
            const bytes = concat(entry.chunks);
            const bodyBytes = bytes.subarray(head.bodyStart);
            if (head.chunked) {
                const decoded = decodeChunked(bodyBytes);
                if (decoded === undefined) {
                    if (closedByPeer) throw new Error('Preview closed the response.');
                    return;
                }
                if (decoded.done) finish(connId, entry, decoded.body);
                return;
            }
            if (head.contentLength !== undefined) {
                if (bodyBytes.length > head.contentLength) throw new Error('Preview response overran its length.');
                if (bodyBytes.length === head.contentLength) finish(connId, entry, bodyBytes.slice());
                else if (closedByPeer) throw new Error('Preview closed the response.');
                return;
            }
            // Close-delimited: the host ends the upstream when the server
            // closes, which arrives as PREVIEW_CLOSE after `Connection: close`.
            if (closedByPeer) {
                if (entry.received > MAX_BODY_BYTES) throw new Error('Preview response is too large.');
                finish(connId, entry, bodyBytes.slice());
            }
        } catch (error) {
            fail(connId, error instanceof Error ? error : new Error(String(error)));
        }
    };

    const bridge: PreviewHttpBridge = {
        request: (target, init) => new Promise<PreviewHttpResponse>((resolve, reject) => {
            let payload: Uint8Array;
            try {
                if (closed) throw new Error('Preview is closed.');
                payload = encodeRequest(target, init);
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            nextConnId = (nextConnId + 1) >>> 0;
            if (nextConnId === 0) nextConnId = 1;
            const connId = nextConnId;
            const entry: PendingRequest = {
                resolve,
                reject,
                chunks: [],
                received: 0,
                head: undefined,
                timer: setTimeout(() => fail(connId, new Error('Preview request timed out.')), REQUEST_TIMEOUT_MS),
            };
            pending.set(connId, entry);
            try {
                options.sendBinary(encodePreviewFrame(connId, PREVIEW_DATA, sealPreviewPayload(payload, clientToHostKey)));
            } catch (error) {
                pending.delete(connId);
                clearTimeout(entry.timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        }),

        handleSocketBytes: (data) => {
            const frame = decodePreviewFrame(data);
            if (frame === undefined) return;
            const entry = pending.get(frame.connId);
            if (entry === undefined) return;
            if (frame.flag === PREVIEW_CLOSE) {
                absorb(frame.connId, entry, true);
                return;
            }
            if (frame.flag !== PREVIEW_DATA || frame.payload.length === 0) return;
            try {
                const plain = openPreviewPayload(frame.payload, hostToClientKey);
                entry.received += plain.length;
                if (entry.received > MAX_BODY_BYTES + 64 * 1024) {
                    throw new Error('Preview response is too large.');
                }
                entry.chunks.push(plain);
            } catch (error) {
                fail(frame.connId, error instanceof Error ? error : new Error(String(error)));
                return;
            }
            absorb(frame.connId, entry, false);
        },

        close: () => {
            if (closed) return;
            closed = true;
            for (const [connId, entry] of [...pending.entries()]) {
                pending.delete(connId);
                clearTimeout(entry.timer);
                entry.reject(new Error('Preview is closed.'));
            }
        },
    };
    return bridge;
}
