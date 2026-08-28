/**
 * Herdr socket client. Newline-delimited JSON over the unix socket.
 *
 * Verified against herdr 0.8.0: the server answers ONE request and closes the
 * connection -- only `events.subscribe` holds its socket open for pushes. So
 * requests get a fresh connection each (unix sockets are cheap) and events get
 * one long-lived subscription socket.
 */

import { connect, type Socket } from 'node:net';

export interface HerdrEvent {
    type: string;
    [key: string]: unknown;
}

const REQUEST_TIMEOUT_MS = 15_000;
// The host and herdr boot together; a short backoff absorbs the startup race.
// After these, start() gives up to the 1s reconnect loop so the host stays up.
const START_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

export class HerdrClient {
    private events: Socket | undefined;
    private eventBuffer = '';
    private seq = 0;
    private readonly listeners = new Set<(event: HerdrEvent) => void>();
    private reconnectTimer: NodeJS.Timeout | undefined;
    private closed = false;
    /** Live event-socket state, surfaced on `herdr.tree` so the phone can tell a dead herdr from a quiet one. */
    connected = false;
    /** Edge trigger: log the first reconnect failure and the recovery, never every retry. */
    private down = false;

    constructor(
        private readonly socketPath: string,
        private readonly onReconnect: () => void,
    ) {}

    async start(): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= START_RETRY_DELAYS_MS.length; attempt += 1) {
            try {
                await this.openEventSocket();
                return;
            } catch (cause) {
                lastError = cause;
                const delay = START_RETRY_DELAYS_MS[attempt];
                if (delay === undefined) break;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        // Staying up matters more than starting clean: the reconnect loop keeps
        // retrying and onReconnect resubscribes when herdr comes back.
        this.down = true;
        this.scheduleReconnect();
        throw lastError;
    }

    /** One request, one connection. The server closes after answering. */
    /**
     * `timeoutMs` overrides the default for methods that block server-side --
     * `agent.wait` can legitimately sit for the length of an agent's turn.
     */
    async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
        if (this.closed) throw new Error('herdr: client closed');
        const id = `pph_${++this.seq}`;
        return await new Promise<T>((resolve, reject) => {
            const socket = connect(this.socketPath);
            let buffer = '';
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`herdr: ${method} timed out`));
            }, timeoutMs ?? REQUEST_TIMEOUT_MS);
            const settle = (error: Error | undefined, value?: T): void => {
                clearTimeout(timer);
                socket.destroy();
                if (error !== undefined) reject(error);
                else resolve(value as T);
            };
            socket.once('error', (error: Error) => settle(new Error(`herdr: ${method}: ${error.message}`)));
            socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
            socket.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.trim().length === 0) continue;
                    const message = parseLine(line);
                    if (message === undefined || message.id !== id) continue;
                    if (message.error !== undefined && message.error !== null) {
                        const detail = message.error as { message?: string; code?: string };
                        settle(new Error(`herdr: ${detail.code ?? 'error'}: ${detail.message ?? `${method} failed`}`));
                        return;
                    }
                    settle(undefined, (message.result ?? {}) as T);
                    return;
                }
            });
            socket.once('close', () => {
                // Server closed without answering (herdr closes after the answer,
                // so this only fires when the answer never came).
                settle(new Error(`herdr: ${method}: connection closed without a response`));
            });
        });
    }

    onEvent(listener: (event: HerdrEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * `pane.agent_status_changed` is a FILTERED subscription (pane_id required);
     * putting it in the batch rejects everything. One socket per pane instead --
     * unix sockets are cheap, and herdr answers one subscribe per socket.
     */
    watchPaneStatus(paneId: string, onStatus: (agentStatus: string) => void): () => void {
        let socket: Socket | undefined;
        let stopped = false;
        let retry: NodeJS.Timeout | undefined;

        const open = (): void => {
            if (stopped) return;
            // Fresh per attempt: a partial line from a dead socket must not
            // corrupt the first frame after a reconnect.
            let buffer = '';
            let rejected = false;
            const next = connect(this.socketPath);
            socket = next;
            next.on('connect', () => {
                next.write(
                    `${JSON.stringify({
                        id: 'pph_status',
                        method: 'events.subscribe',
                        params: { subscriptions: [{ type: 'pane.agent_status_changed', pane_id: paneId }] },
                    })}\n`,
                );
            });
            next.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.trim().length === 0) continue;
                    const message = parseLine(line);
                    if (message === undefined) continue;
                    // Rejection frames carry id:"" -- visible only by checking
                    // error before the id guard, and retrying a rejected
                    // subscription just loops the rejection every 2s forever.
                    if (message.error !== undefined && message.error !== null) {
                        const detail = message.error as { message?: string; code?: string };
                        process.stderr.write(
                            `herdr: status watch for ${paneId} rejected: ${detail.code ?? 'error'}: ${detail.message ?? 'unknown'}\n`,
                        );
                        rejected = true;
                        next.destroy();
                        return;
                    }
                    if (typeof message.id === 'string') continue;
                    const data = (message.data ?? message) as { agent_status?: unknown };
                    if (typeof data.agent_status === 'string') onStatus(data.agent_status);
                }
            });
            next.on('close', () => {
                if (stopped || rejected) return;
                retry = setTimeout(open, 2000);
                retry.unref();
            });
            next.on('error', () => {});
        };
        open();

        return () => {
            stopped = true;
            if (retry !== undefined) clearTimeout(retry);
            socket?.destroy();
        };
    }

    /** The subscription socket: one request, then pushes for the life of the socket. */
    async subscribeEvents(kinds: string[]): Promise<void> {
        if (this.events === undefined) throw new Error('herdr: event socket not connected');
        this.events.write(
            `${JSON.stringify({ id: 'pph_sub', method: 'events.subscribe', params: { subscriptions: kinds.map((type) => ({ type })) } })}\n`,
        );
    }

    close(): void {
        this.closed = true;
        this.connected = false;
        if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
        this.events?.destroy();
    }

    private async openEventSocket(): Promise<void> {
        const socket = connect(this.socketPath);
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', (cause: Error) => reject(new Error(
                `herdr server not reachable at ${this.socketPath} (${cause.message}); start it with \`herdr server\``,
            )));
        });
        // A partial line from the dead socket must not corrupt this one.
        this.eventBuffer = '';
        this.events = socket;
        socket.on('data', (chunk: Buffer) => {
            this.eventBuffer += chunk.toString('utf8');
            const lines = this.eventBuffer.split('\n');
            this.eventBuffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim().length === 0) continue;
                const message = parseLine(line);
                if (message === undefined) continue;
                // A rejected subscribe answers with an error frame whose id is the
                // EMPTY string (herdr 0.8.0) -- and one bad kind rejects the whole
                // subscription, so zero events would ever arrive. Without this
                // branch the error is structurally invisible and the host looks
                // healthy while every session freezes at its initial snapshot.
                if (message.error !== undefined && message.error !== null) {
                    const detail = message.error as { message?: string; code?: string };
                    process.stderr.write(
                        `herdr: event socket rejected: ${detail.code ?? 'error'}: ${detail.message ?? 'unknown'}\n`,
                    );
                    continue;
                }
                // The subscribe ack has an id; everything after is a pushed event.
                if (typeof message.id === 'string') continue;
                // Wire shape (verified): {"data": {...}, "event": "pane.x"} -- the
                // event NAME is a string sibling, not an object. Older replayed
                // frames carry the type inside data instead; accept both.
                const data = (message.data ?? message) as Record<string, unknown>;
                const type = typeof message.event === 'string' ? message.event : data.type;
                if (typeof type !== 'string') continue;
                const event = { ...data, type } as HerdrEvent;
                for (const listener of this.listeners) listener(event);
            }
        });
        socket.on('close', () => {
            this.events = undefined;
            this.connected = false;
            this.scheduleReconnect();
        });
        socket.on('error', () => {});
        this.connected = true;
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer !== undefined) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.closed) return;
            void this.openEventSocket()
                .then(() => {
                    if (this.down) {
                        this.down = false;
                        process.stderr.write(`herdr server reachable again at ${this.socketPath}\n`);
                    }
                    this.onReconnect();
                })
                .catch((cause: unknown) => {
                    if (!this.down) {
                        this.down = true;
                        process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
                    }
                    this.scheduleReconnect();
                });
        }, 1000);
    }
}

function parseLine(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);
        return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}
