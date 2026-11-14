/**
 * The host's live terminal on Herdr Core (jg-kile slice 7, lab only).
 *
 * One framed connection per terminal view. After `hello {framed: true}` the connection carries
 * length-prefixed frames: `channel u32 | kind u8 | length u32 | payload`, little endian. Channel 0
 * is JSON-RPC; `terminal.attach` returns a stream channel whose DATA frames are screen bytes (the
 * first paint, then live output) and whose inbound DATA frames are keys.
 *
 * It presents the same `TerminalSession` the terminal manager already drives (NDJSON frames out,
 * NDJSON input lines in), so nothing above it changes:
 * - output: one `terminal.frame` per DATA payload; the first is the whole-screen repaint (`full`).
 * - input: `terminal.input` text or base64 bytes become DATA; `terminal.resize` becomes RESIZE for a
 *   controller; `terminal.release` ends the view. `terminal.scroll` is dropped: Core's viewer owns no
 *   scrollback offset the phone could move (scroll position is no longer read from the computer).
 * - cursor: Core sends no cursor, so each frame ends with the trailer Herdr sends, read from a headless terminal fed the same bytes (herdrCoreCursor.ts).
 * - flow control: Core sends only as many bytes as the viewer has granted in CREDIT frames. A credit
 *   goes back after each payload is handed on, and not while the consumer is paused, so a slow
 *   phone holds Core back instead of this host buffering without bound.
 * - an `observe` view never resizes the terminal and never types, so a preview card watches only.
 */

import { createConnection } from 'node:net';
import type { TerminalSession } from '@byokit/herdr';
import { createCoreCursor, type CoreCursor } from './herdrCoreCursor.js';

/** Frame kinds of Core's framed mode (RESIZE carries `cols u16 | rows u16`, little endian). */
const KIND = { DATA: 0, CREDIT: 1, CLOSE: 2, RESIZE: 3 } as const;
const HEADER = 9;
/** A frame larger than this means the stream is corrupt, not that Core sent a big screen. */
const MAX_PAYLOAD = 64 * 1024 * 1024;

export interface HerdrCoreTerminalOptions {
    mode: 'control' | 'observe';
    cols: number;
    rows: number;
}

const frameOf = (channel: number, kind: number, payload: Buffer): Buffer => {
    const head = Buffer.alloc(HEADER);
    head.writeUInt32LE(channel, 0);
    head.writeUInt8(kind, 4);
    head.writeUInt32LE(payload.length, 5);
    return Buffer.concat([head, payload]);
};

export function openHerdrCoreTerminal(socketPath: string, address: string, options: HerdrCoreTerminalOptions): TerminalSession {
    const observe = options.mode === 'observe';
    const socket = createConnection(socketPath);
    const listeners = new Set<(line: string) => void>();
    let buffer: Buffer = Buffer.alloc(0);
    let framed = false;
    let nextId = 0;
    let channel: number | undefined;
    let width = options.cols;
    let height = options.rows;
    let sequence = 0;
    let firstPaint = true;
    // Core repaints the whole screen after it resizes; the phone drops a diff whose size is not its own until then.
    let repaintAfterResize = false;
    let cursor: CoreCursor | undefined;
    let paused = false;
    let delivering = false;
    let ended = false;
    const queue: Buffer[] = [];
    const calls = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

    let readyResolve: () => void = () => undefined;
    let readyReject: (error: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // `ready` is awaited by the terminal manager; an unobserved rejection must not crash the host.
    ready.catch(() => undefined);
    let exitedResolve: (value: { code: number | null; stderrTail: string }) => void = () => undefined;
    const exited = new Promise<{ code: number | null; stderrTail: string }>((resolve) => { exitedResolve = resolve; });

    const end = (code: number | null, reason: string): void => {
        if (ended) return;
        ended = true;
        readyReject(new Error(`herdr core terminal ended before output: ${reason}`));
        for (const waiter of calls.values()) waiter.reject(new Error(reason));
        calls.clear();
        cursor?.dispose();
        socket.destroy();
        exitedResolve({ code, stderrTail: reason });
    };

    const write = (data: Buffer | string): void => { if (!ended && socket.writable) socket.write(data); };
    const send = (kind: number, payload: Buffer): void => { if (channel !== undefined) write(frameOf(channel, kind, payload)); };
    const grant = (bytes: number): void => {
        const credit = Buffer.alloc(4);
        credit.writeUInt32LE(bytes, 0);
        send(KIND.CREDIT, credit);
    };

    const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
        const id = ++nextId;
        calls.set(id, { resolve, reject });
        const text = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        write(framed ? frameOf(0, KIND.DATA, Buffer.from(text)) : `${text}\n`);
    });

    let attachId = -1;
    const adopt = (attached: Record<string, unknown>): void => {
        channel = Number(attached.channel);
        const size = attached.terminal as { cols?: number; rows?: number } | undefined;
        // An observer sees the terminal at the size the computer holds, never the size it asked for.
        if (typeof size?.cols === 'number' && typeof size.rows === 'number') { width = size.cols; height = size.rows; }
    };

    const onMessage = (message: { id?: number; result?: Record<string, unknown>; error?: { message: string } }): void => {
        // The first paint can follow the attach reply in the same chunk: take the channel before reading on.
        if (message.id === attachId && message.result !== undefined) adopt(message.result);
        const waiter = message.id === undefined ? undefined : calls.get(message.id);
        if (waiter === undefined || message.id === undefined) return;
        calls.delete(message.id);
        if (message.error === undefined) waiter.resolve(message.result ?? {});
        else waiter.reject(new Error(message.error.message));
    };

    /** Hand queued screen bytes on, one frame each, while the consumer is not paused. */
    const deliver = async (): Promise<void> => {
        if (delivering) return;
        delivering = true;
        try {
            while (!paused && !ended) {
                const payload = queue.shift();
                if (payload === undefined) break;
                // The phone's pan reads the cursor from the end of a frame, as Herdr sends it.
                cursor ??= createCoreCursor(width, height);
                const back = firstPaint ? Buffer.alloc(0) : cursor.restore();
                const trailer = await cursor.feed(payload);
                if (ended) break;
                const line = JSON.stringify({
                    type: 'terminal.frame',
                    bytes: Buffer.concat([back, payload, trailer]).toString('base64'),
                    full: firstPaint || repaintAfterResize,
                    seq: sequence++,
                    width,
                    height,
                });
                if (firstPaint) { firstPaint = false; readyResolve(); }
                repaintAfterResize = false;
                for (const listener of listeners) listener(line);
                grant(payload.length);
            }
        } finally {
            delivering = false;
        }
    };

    const onFrame = (frameChannel: number, kind: number, payload: Buffer): void => {
        if (frameChannel === 0 && kind === KIND.DATA) { onMessage(JSON.parse(payload.toString('utf8'))); return; }
        if (channel === undefined || frameChannel !== channel) return;
        if (kind === KIND.DATA) { queue.push(payload); void deliver(); return; }
        if (kind === KIND.RESIZE && payload.length >= 4) { width = payload.readUInt16LE(0); height = payload.readUInt16LE(2); cursor?.resize(width, height); repaintAfterResize = true; return; }
        if (kind === KIND.CLOSE) end(0, payload.toString('utf8') || 'closed');
    };

    socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
            while (!framed) {
                const newline = buffer.indexOf(10);
                if (newline < 0) return;
                const message = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
                buffer = buffer.subarray(newline + 1);
                // The hello reply is the last plain line; everything after it is framed.
                if (message.id === 1) framed = true;
                onMessage(message);
            }
            while (buffer.length >= HEADER) {
                const length = buffer.readUInt32LE(5);
                if (length > MAX_PAYLOAD) throw new Error(`frame of ${String(length)} bytes`);
                if (buffer.length < HEADER + length) return;
                const frameChannel = buffer.readUInt32LE(0);
                const kind = buffer.readUInt8(4);
                const payload = buffer.subarray(HEADER, HEADER + length);
                buffer = buffer.subarray(HEADER + length);
                onFrame(frameChannel, kind, payload);
            }
        } catch (cause) {
            end(null, `Herdr Core sent a stream this host cannot read: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    });
    socket.on('error', (cause) => end(null, `Herdr Core is not answering on ${socketPath}: ${cause.message}`));
    socket.on('close', () => end(null, 'Herdr Core closed the terminal connection'));

    socket.once('connect', () => {
        void (async () => {
            const hello = await call('hello', { framed: true });
            if (hello.framed !== true) throw new Error('Herdr Core did not switch to framed mode');
            attachId = nextId + 1;
            await call('terminal.attach', { terminal: address, observe, cols: options.cols, rows: options.rows });
        })().catch((cause: unknown) => end(null, cause instanceof Error ? cause.message : String(cause)));
    });

    const input = (line: string): void => {
        let record: { type?: unknown; text?: unknown; bytes?: unknown; cols?: unknown; rows?: unknown };
        try { record = JSON.parse(line); } catch { return; }
        if (record.type === 'terminal.release') { close(); return; }
        if (observe) return;
        if (record.type === 'terminal.input') {
            if (typeof record.text === 'string') send(KIND.DATA, Buffer.from(record.text, 'utf8'));
            else if (typeof record.bytes === 'string') send(KIND.DATA, Buffer.from(record.bytes, 'base64'));
        } else if (record.type === 'terminal.resize' && Number.isInteger(record.cols) && Number.isInteger(record.rows)) {
            const size = Buffer.alloc(4);
            size.writeUInt16LE(Number(record.cols), 0);
            size.writeUInt16LE(Number(record.rows), 2);
            send(KIND.RESIZE, size);
        }
    };

    const close = (): void => {
        if (ended) return;
        send(KIND.CLOSE, Buffer.alloc(0));
        end(0, 'closed');
    };

    return {
        ready,
        exited,
        onFrame(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        send: input,
        pause() { paused = true; },
        resume() { paused = false; void deliver(); },
        close,
    };
}
