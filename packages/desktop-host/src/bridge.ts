/**
 * A consumer-facing transport for the engine's local protocol.
 *
 * The engine speaks newline-delimited JSON on stdio, which is the right shape
 * for a consumer that already holds the process. A consumer whose client is on
 * another machine needs something to carry that protocol further, and inventing
 * one is exactly the work this package is supposed to remove. `Bridge` re-serves
 * the same protocol over a WebSocket, so a browser, a phone or a script connects
 * with nothing but a WebSocket.
 *
 * This is a *consumer-side* convenience, not engine surface: the engine still
 * has no listener, and the bridge is started by whoever owns the machine.
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';

import { EngineClient, type EngineClientOptions } from './engineProcess.js';
import type { SourceRequest } from './protocol.js';

export interface BridgeOptions {
    /** Address to listen on, e.g. `127.0.0.1:19400` or `0.0.0.0:19400`. */
    listen: string;
    /**
     * Shared secret required on the socket path. Required, not optional: this
     * channel grants control of a desktop, and `ws://` is plaintext, so an
     * unauthenticated one on a reachable address is a remote-control port for
     * anyone who finds it.
     */
    token: string;
    engineCommand: string;
    engineArgs: string[];
    /** Serve the reference client page at `/?token=…` so the bridge is usable at once. */
    serveExample?: boolean;
    /**
     * Which desktop this bridge offers. A bridge is bound to one machine and one
     * desktop, and the client on the other end has no way to know whether that
     * machine has a working screen-cast portal, so the choice belongs here.
     */
    source?: SourceRequest;
    engineOptions?: EngineClientOptions;
}

/** The path a client connects to: `/desktop?token=…`. */
export const BRIDGE_PATH = '/desktop';

/**
 * The reference client, served as one file with no build step. It is the
 * smallest thing that shows a desktop in a browser, and it doubles as the worked
 * example an application can read instead of reverse-engineering the protocol.
 */
function examplePage(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', 'examples', 'reference-client.html'), 'utf8');
}

export class Bridge {
    private closing = false;
    /** The session the engine holds, so a consumer that vanishes can release it. */
    private session: { sessionId: string; generation?: number } | undefined;

    private constructor(
        private readonly server: Server,
        private readonly sockets: WebSocketServer,
        private readonly engine: EngineClient,
        private readonly defaultSource: SourceRequest | undefined,
    ) {}

    static async start(options: BridgeOptions): Promise<Bridge> {
        if (options.token.trim() === '') throw new Error('the bridge token must not be blank');
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            // The page is served only to a caller that already has the token: an
            // unauthenticated page that connects to a desktop would be a worse
            // secret than the socket itself.
            if (options.serveExample !== false && url.pathname === '/' && url.searchParams.get('token') === options.token) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                response.end(examplePage());
                return;
            }
            response.writeHead(404);
            response.end('not found');
        });
        const sockets = new WebSocketServer({
            server,
            path: BRIDGE_PATH,
            // The token in the URL is the whole authorisation for this socket.
            // It is deliberately checked here rather than in the first message:
            // an unauthenticated socket must not be able to reach the engine at
            // all, not merely be refused an answer.
            verifyClient: ((info: { req: IncomingMessage }) => {
                const url = new URL(info.req.url ?? '/', 'http://localhost');
                return url.searchParams.get('token') === options.token;
            }) as VerifyClientCallbackSync<IncomingMessage>,
        });

        const engine = await EngineClient.start(options.engineCommand, options.engineArgs, {
            ...(options.engineOptions ?? {}),
            // Grant credentials stay with the host; session notifications go
            // to the attached controllers watching this session.
            onEvent: (event) => {
                options.engineOptions?.onEvent?.(event);
                if (event.event === 'session.restoreToken') return;
                const line = JSON.stringify(event);
                for (const socket of sockets.clients) {
                    if (socket.readyState === socket.OPEN) socket.send(line);
                }
            },
        });

        const bridge = new Bridge(server, sockets, engine, options.source);
        sockets.on('connection', (socket) => bridge.attach(socket));

        const address = splitAddress(options.listen);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(address.port, address.host, () => resolve());
        });
        return bridge;
    }

    /** The port actually bound, which matters when the caller asked for `:0`. */
    get port(): number {
        const address = this.server.address();
        return typeof address === 'object' && address !== null ? address.port : 0;
    }

    private attach(socket: WebSocket): void {
        socket.on('message', (raw) => {
            let request: { id?: number; method?: string; params?: Record<string, unknown> };
            try {
                request = JSON.parse(String(raw)) as typeof request;
            } catch {
                socket.send(JSON.stringify({ error: { code: 'malformed', message: 'not JSON' } }));
                return;
            }
            if (request === null || typeof request !== 'object' || Array.isArray(request)) {
                socket.send(JSON.stringify({ error: { code: 'malformed', message: 'expected a request object' } }));
                return;
            }
            const method = request.method;
            if (typeof method !== 'string') return;
            if (method === 'session.open' && request.params != null && Object.prototype.hasOwnProperty.call(request.params, 'source')) {
                socket.send(JSON.stringify({ id: request.id, error: { code: 'source', message: 'the client cannot choose the desktop source' } }));
                return;
            }
            const params = method === 'session.open' && this.defaultSource !== undefined
                ? { ...(request.params ?? {}), source: this.defaultSource }
                : request.params;
            void this.engine
                .request<Record<string, unknown>>(method, params)
                .then((result) => {
                    this.rememberSession(method, result);
                    const forwarded = this.defaultSource?.kind === 'x11'
                        && (method === 'hello' || method === 'capabilities')
                        && result !== null && result.clipboard !== null && typeof result.clipboard === 'object'
                        ? { ...result, clipboard: { ...result.clipboard, read: false, write: false } }
                        : result;
                    if (method === 'session.open' && socket.readyState !== socket.OPEN) {
                        this.releaseSessionIfDetached(true);
                        return;
                    }
                    if (request.id !== undefined && socket.readyState === socket.OPEN) {
                        socket.send(JSON.stringify({ id: request.id, result: forwarded }));
                    }
                })
                .catch((error: unknown) => {
                    if (request.id === undefined || socket.readyState !== socket.OPEN) return;
                    socket.send(JSON.stringify({
                        id: request.id,
                        error: {
                            code: (error as { code?: string }).code ?? 'engine',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    }));
                });
        });

        // A consumer that disappears mid-gesture — a closed tab, a lost phone,
        // a killed process — must not leave the desktop holding synthetic input
        // until the engine's lease expires. Nothing keeps the session for a
        // consumer that might reconnect: a reconnect opens a fresh one.
        const release = (): void => this.releaseSessionIfDetached();
        socket.on('close', release);
        socket.on('error', release);
    }

    private rememberSession(method: string, result: unknown): void {
        if (method === 'session.close') {
            this.session = undefined;
            return;
        }
        if (method !== 'session.open') return;
        const opened = result as { sessionId?: unknown; generation?: unknown } | null;
        if (typeof opened?.sessionId !== 'string') return;
        this.session = typeof opened.generation === 'number'
            ? { sessionId: opened.sessionId, generation: opened.generation }
            : { sessionId: opened.sessionId };
    }

    private releaseSessionIfDetached(force = false): void {
        if (this.closing || (!force && this.sockets.clients.size > 0)) return;
        const session = this.session;
        this.session = undefined;
        if (session === undefined) return;
        void this.engine
            .request('session.close', {
                session_id: session.sessionId,
                ...(session.generation !== undefined ? { generation: session.generation } : {}),
            })
            .catch(() => undefined);
    }

    async close(): Promise<void> {
        if (this.closing) return;
        this.closing = true;
        for (const socket of this.sockets.clients) socket.close();
        await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        await this.engine.stop().catch(() => undefined);
    }
}

function splitAddress(listen: string): { host: string; port: number } {
    const index = listen.lastIndexOf(':');
    if (index <= 0) return { host: '127.0.0.1', port: Number(listen) || 0 };
    return { host: listen.slice(0, index), port: Number(listen.slice(index + 1)) || 0 };
}
