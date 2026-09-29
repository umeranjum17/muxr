/**
 * HerdrKit-backed transport adapter. HerdrKit owns the socket, the event
 * batch and the per-pane status watches; this class keeps the exact surface
 * the session source was written against (positional timeouts, onEvent
 * fan-out, a connected flag, id-based status-watch readiness) so every
 * `client.call(m, p, t)` site rides the kit without edits.
 *
 * Adopt-mode spawns take the host PATH plus the identity vars Herdr reads
 * through the kit's env/path options; the socket path needs no env because
 * `bin` is spawned with it directly.
 */
import { homedir } from 'node:os';
import { HerdrKit } from '@byokit/herdr';

export interface HerdrEvent {
    type: string;
    [key: string]: unknown;
}

/** The only shape the session source needs from a socket caller. */
export interface HerdrCaller {
    call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

// The host and herdr boot together; a short backoff absorbs the startup race.
// After these, start() gives up to the 1s reconnect loop so the host stays up.
const START_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

const EVENT_SUBSCRIPTION = (type: string): { type: string; [key: string]: unknown } => ({ type });

export class KitHerdrClient implements HerdrCaller {
    /** Live event-socket state, surfaced on `herdr.tree` so the phone can tell a dead herdr from a quiet one. */
    connected = false;
    readonly kit: HerdrKit;
    private readonly listeners = new Set<(event: HerdrEvent) => void>();
    private batchStop: (() => void) | undefined;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private started = false;
    private closed = false;
    /** Edge trigger: log the first reconnect failure and the recovery, never every retry. */
    private down = false;

    constructor(
        bin: string,
        private readonly socketPath: string,
        private readonly onReconnect: () => void,
    ) {
        // Adopt-mode spawns (CLI, terminal) need the host's PATH (mise shims,
        // hostedtoolcache) plus the identity vars Herdr itself reads. The kit
        // merges `env` over its fixed adopt base and joins `path` for PATH.
        const kitEnv: Record<string, string> = {
            HOME: homedir(),
            ...(process.env.HERDR_CLIENT_SOCKET_PATH === undefined
                ? {}
                : { HERDR_CLIENT_SOCKET_PATH: process.env.HERDR_CLIENT_SOCKET_PATH }),
            ...(process.env.HERDR_SESSION === undefined ? {} : { HERDR_SESSION: process.env.HERDR_SESSION }),
        };
        this.kit = new HerdrKit({
            mode: 'adopt',
            bin,
            socketPath,
            env: kitEnv,
            path: (process.env.PATH ?? '').split(':').filter((dir) => dir !== ''),
            onState: (state) => {
                const ready = state.phase === 'ready';
                this.connected = ready;
                // The batch socket heals itself; the mirror still needs its
                // resync pass when herdr comes back after an outage.
                if (ready && this.started) this.onReconnect();
            },
        });
    }

    /** Only a down server is worth retrying: a version mismatch or a rejected
     * subscription fails closed with its message instead of stacking attempts. */
    private static isDownError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return /socket unavailable|socket closed|request timed out|ECONNREFUSED|ENOENT|EACCES|connect E|not connected/i.test(message);
    }

    async start(): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= START_RETRY_DELAYS_MS.length; attempt += 1) {
            try {
                await this.kit.start();
                this.started = true;
                return;
            } catch (cause) {
                lastError = cause;
                if (!KitHerdrClient.isDownError(cause)) throw cause;
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
        return await this.kit.call(
            method as never,
            params as never,
            timeoutMs === undefined ? undefined : { timeoutMs },
        ) as T;
    }

    onEvent(listener: (event: HerdrEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** The subscription socket: one request, then pushes for the life of the socket. */
    async subscribeEvents(kinds: string[]): Promise<void> {
        this.batchStop?.();
        const stop = (this.kit.subscribe as (
            subs: Array<{ type: string; [key: string]: unknown }>,
            on: (event: HerdrEvent) => void,
        ) => () => void)(
            kinds.map(EVENT_SUBSCRIPTION),
            (event) => {
                for (const listener of this.listeners) listener(event);
            },
        );
        this.batchStop = stop;
    }

    /**
     * `pane.agent_status_changed` is a FILTERED subscription (pane_id required);
     * putting it in the batch rejects everything. One socket per pane instead.
     */
    watchPaneStatus(paneId: string, onStatus: (agentStatus: string) => void, onReady: () => void): () => void {
        const stop = (this.kit.subscribe as (
            subs: Array<{ type: string; [key: string]: unknown }>,
            on: (event: HerdrEvent) => void,
        ) => () => void)(
            [{ type: 'pane.agent_status_changed', pane_id: paneId }],
            (event) => {
                // The kit spreads the frame data onto the event, so the status
                // rides top-level exactly as the old client delivered it.
                if (typeof event.agent_status === 'string') onStatus(event.agent_status);
            },
        );
        // The declared type hides it, but the kit resolves `ready` on the
        // subscribe ack -- the same edge the old client used for onReady.
        const ready = (stop as { ready?: Promise<boolean> }).ready;
        if (ready !== undefined) {
            void ready.then((ok) => {
                if (ok !== false) onReady();
            }).catch(() => {});
        }
        return stop;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.connected = false;
        if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
        this.batchStop?.();
        this.batchStop = undefined;
        await this.kit.stop().catch(() => {});
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer !== undefined) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.closed) return;
            void this.kit.start()
                .then(() => {
                    if (this.down) {
                        this.down = false;
                        process.stderr.write(`herdr server reachable again at ${this.socketPath}\n`);
                    }
                    this.started = true;
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
