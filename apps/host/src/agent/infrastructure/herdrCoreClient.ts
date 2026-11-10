/**
 * The host's connection to Herdr Core: JSON-RPC lines on its local socket.
 *
 * Two connections, because a plain-mode `events.subscribe` leaves its connection carrying only
 * notifications: one for calls, one for the event stream. Both say `hello` first and refuse a
 * Core whose protocol generation is newer than this host understands.
 *
 * The watcher owns the resync rule: Core sends `missed` plus a fresh snapshot to a subscriber that
 * fell behind, and the watcher hands that snapshot on as a full replacement, taking `terminal.list`
 * itself when the notice carries none. Events are absolute facts, so applying one twice is safe.
 */

import { createConnection, type Socket } from 'node:net';
import type { CoreTerminal } from '../domain/herdrCoreAgents.js';

/** The newest Core protocol generation this host speaks. */
export const SUPPORTED_CORE_GENERATION = 1;

export class HerdrCoreError extends Error {
    constructor(message: string, readonly kind?: string) {
        super(message);
        this.name = 'HerdrCoreError';
    }
}

export interface CoreEvent {
    type: string;
    terminal?: string;
    seq: number;
    data: Record<string, unknown>;
}

interface Line {
    call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
    onNotification(listener: (params: Record<string, unknown>) => void): void;
    onClose(listener: (error?: Error) => void): void;
    destroy(): void;
}

const CALL_TIMEOUT_MS = 30_000;

async function openLine(socketPath: string): Promise<Line> {
    const socket: Socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', (cause) => reject(new HerdrCoreError(`Herdr Core is not answering on ${socketPath}: ${cause.message}`)));
    });
    let buffer = '';
    let nextId = 0;
    let notify: (params: Record<string, unknown>) => void = () => undefined;
    let closed: (error?: Error) => void = () => undefined;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const failAll = (error: Error): void => {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            const text = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (text.trim() === '') continue;
            const message = JSON.parse(text) as { id?: number; result?: unknown; error?: { message: string; data?: { kind?: string } }; method?: string; params?: Record<string, unknown> };
            const waiter = message.id === undefined ? undefined : pending.get(message.id);
            if (waiter !== undefined && message.id !== undefined) {
                pending.delete(message.id);
                if (message.error === undefined) waiter.resolve(message.result);
                else waiter.reject(new HerdrCoreError(message.error.message, message.error.data?.kind));
            } else if (message.method === 'event' && message.params !== undefined) notify(message.params);
        }
    });
    socket.on('close', () => {
        const error = new HerdrCoreError('Herdr Core closed the connection');
        failAll(error);
        closed(error);
    });
    socket.on('error', (cause) => failAll(new HerdrCoreError(`Herdr Core connection failed: ${cause.message}`)));
    return {
        call: <T>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); reject(new HerdrCoreError(`${method} timed out`)); }, CALL_TIMEOUT_MS);
            pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value as T); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        }),
        onNotification: (listener) => { notify = listener; },
        onClose: (listener) => { closed = listener; },
        destroy: () => socket.destroy(),
    };
}

async function greet(line: Line): Promise<void> {
    const hello = await line.call<{ generation: number; version: string }>('hello', {});
    if (hello.generation > SUPPORTED_CORE_GENERATION) {
        line.destroy();
        throw new HerdrCoreError(`Herdr Core ${hello.version} speaks protocol generation ${String(hello.generation)}; this muxr understands up to ${String(SUPPORTED_CORE_GENERATION)}. Update muxr.`, 'generation_newer');
    }
}

export interface CoreWatchHandlers {
    /** Every terminal Core knows now: the first snapshot, and the fresh one after `missed`. */
    onSnapshot(terminals: CoreTerminal[]): void;
    onEvent(event: CoreEvent): void;
    /** The event stream ended; nothing more arrives until a new watch is opened. */
    onClosed(error: Error): void;
}

export interface HerdrCoreClient {
    call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
    list(): Promise<CoreTerminal[]>;
    /** Subscribe: the snapshot first, then every event, resyncing after `missed`. */
    watch(handlers: CoreWatchHandlers): Promise<void>;
    close(): void;
}

export async function connectHerdrCore(socketPath: string): Promise<HerdrCoreClient> {
    const calls = await openLine(socketPath);
    await greet(calls);
    let events: Line | undefined;
    let closing = false;
    const list = async (): Promise<CoreTerminal[]> => (await calls.call<{ terminals: CoreTerminal[] }>('terminal.list', {})).terminals;
    return {
        call: calls.call,
        list,
        async watch(handlers) {
            const stream = await openLine(socketPath);
            events = stream;
            await greet(stream);
            let floor = 0;
            stream.onNotification((params) => {
                const event = params as unknown as CoreEvent;
                if (event.type === 'heartbeat') return;
                if (event.type === 'missed') {
                    // The notice carries the fresh snapshot; events at or below its seq are already in it.
                    const fresh = event.data?.terminals as CoreTerminal[] | undefined;
                    floor = typeof event.data?.seq === 'number' ? event.data.seq : 0;
                    if (fresh !== undefined) { handlers.onSnapshot(fresh); return; }
                    // No snapshot in the notice: take one ourselves.
                    void list().then(handlers.onSnapshot, (cause: unknown) => handlers.onClosed(cause instanceof Error ? cause : new Error(String(cause))));
                    return;
                }
                if (event.seq <= floor) return;
                handlers.onEvent(event);
            });
            stream.onClose((error) => { if (!closing) handlers.onClosed(error ?? new HerdrCoreError('Herdr Core closed the event stream')); });
            const first = await stream.call<{ seq: number; terminals: CoreTerminal[] }>('events.subscribe', {});
            floor = first.seq;
            handlers.onSnapshot(first.terminals);
        },
        close() {
            closing = true;
            events?.destroy();
            calls.destroy();
        },
    };
}
