import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
    EngineRefused,
    PROTOCOL_VERSION,
    type EngineCapabilities,
    type EngineEvent,
    type OpenedSession,
    type OpenSessionRequest,
    type SessionMetrics,
} from './protocol.js';

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export interface EngineClientOptions {
    /** Request timeout. Long enough for a portal consent prompt, and no longer. */
    requestTimeoutMs?: number;
    onEvent?: (event: EngineEvent) => void;
    /** Called when the engine process goes away, with whatever it said first. */
    onExit?: (detail: { code: number | null; signal: NodeJS.Signals | null }) => void;
    onDiagnostic?: (line: string) => void;
}

/**
 * A consumer of the engine's local control protocol.
 *
 * The engine is this process's child and speaks newline-delimited JSON on
 * stdin/stdout, so the channel inherits this process's own access control: same
 * user, same session, no socket to protect and no second authorization scheme.
 */
export class EngineClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, Pending>();
    private readonly queue: EngineEvent[] = [];
    private nextId = 1;
    private closed = false;
    private readonly timeoutMs: number;

    private constructor(child: ChildProcessWithoutNullStreams, options: EngineClientOptions) {
        this.child = child;
        this.timeoutMs = options.requestTimeoutMs ?? 30_000;

        const stdout = createInterface({ input: child.stdout });
        stdout.on('line', (line) => this.handleLine(line, options));
        const stderr = createInterface({ input: child.stderr });
        stderr.on('line', (line) => options.onDiagnostic?.(line));
        child.on('exit', (code, signal) => {
            this.closed = true;
            for (const [id, pending] of this.pending) {
                this.pending.delete(id);
                clearTimeout(pending.timer);
                pending.reject(new Error('the desktop engine exited'));
            }
            options.onExit?.({ code, signal });
        });
        child.on('error', (error) => {
            this.closed = true;
            options.onDiagnostic?.(`engine process error: ${error.message}`);
        });
    }

    /** Start an engine process and complete the protocol handshake. */
    static async start(
        command: string,
        args: string[],
        options: EngineClientOptions = {},
        env: NodeJS.ProcessEnv = process.env,
    ): Promise<EngineClient> {
        const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        const client = new EngineClient(child, options);
        await client.request('hello', { protocol: PROTOCOL_VERSION, client: 'consumer' });
        return client;
    }

    private handleLine(line: string, options: EngineClientOptions): void {
        const trimmed = line.trim();
        if (trimmed === '') return;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            options.onDiagnostic?.(`engine sent a line that is not JSON: ${trimmed.slice(0, 200)}`);
            return;
        }
        if (typeof parsed.event === 'string') {
            const event = parsed as unknown as EngineEvent;
            // Setup notifications are drained by the consumer; queue them so a
            // slow reader cannot lose an offer or a candidate.
            this.queue.push(event);
            options.onEvent?.(event);
            return;
        }
        const id = typeof parsed.id === 'number' ? parsed.id : undefined;
        if (id === undefined) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const error = parsed.error as { code?: string; message?: string } | undefined;
        if (error !== undefined) {
            pending.reject(new EngineRefused(error.code ?? 'engine', error.message ?? 'the engine refused the request'));
            return;
        }
        pending.resolve(parsed.result);
    }

    /**
     * One request on the engine's protocol.
     *
     * Public because the protocol *is* the contract: a consumer that wants to
     * add a capability the typed helpers do not cover should send it rather than
     * patch this package.
     */
    request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (this.closed) {
            return Promise.reject(new Error('the desktop engine is not running'));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`the desktop engine did not answer ${method} in ${this.timeoutMs}ms`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
            this.child.stdin.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`, (error) => {
                if (error !== null && error !== undefined) {
                    this.pending.delete(id);
                    clearTimeout(timer);
                    reject(error);
                }
            });
        });
    }

    capabilities(): Promise<EngineCapabilities> {
        return this.request<EngineCapabilities>('capabilities');
    }

    openSession(request: OpenSessionRequest): Promise<OpenedSession> {
        return this.request<OpenedSession>('session.open', {
            ...(request.source === undefined ? {} : { source: request.source }),
            permissions: request.permissions,
            ...(request.maxWidth === undefined ? {} : { max_width: request.maxWidth }),
            ...(request.maxHeight === undefined ? {} : { max_height: request.maxHeight }),
            ...(request.bitrateKbps === undefined ? {} : { bitrate_kbps: request.bitrateKbps }),
            ...(request.maxFps === undefined ? {} : { max_fps: request.maxFps }),
            ...(request.iceServers === undefined ? {} : { ice_servers: request.iceServers }),
            ...(request.relayOnly === undefined ? {} : { relay_only: request.relayOnly }),
            ...(request.restoreToken === undefined ? {} : { restore_token: request.restoreToken }),
            ...(request.ttlSeconds === undefined ? {} : { ttl_seconds: request.ttlSeconds }),
        });
    }

    acceptAnswer(sessionId: string, generation: number, sdp: string): Promise<{ accepted: boolean }> {
        return this.request('session.description', {
            session_id: sessionId,
            generation,
            description: { type: 'answer', sdp },
        });
    }

    addCandidate(
        sessionId: string,
        generation: number,
        candidate: string,
        sdpMid: string | null,
        sdpMLineIndex: number | null,
    ): Promise<{ accepted: boolean }> {
        return this.request('session.candidate', {
            session_id: sessionId,
            generation,
            candidate,
            sdp_mid: sdpMid,
            sdp_m_line_index: sdpMLineIndex,
        });
    }

    metrics(): Promise<SessionMetrics> {
        return this.request<SessionMetrics>('session.metrics');
    }

    readClipboard(sessionId: string): Promise<{ text: string; truncated: boolean }> {
        return this.request('session.clipboard.read', { session_id: sessionId });
    }

    writeClipboard(sessionId: string, text: string): Promise<{ written: boolean }> {
        return this.request('session.clipboard.write', { session_id: sessionId, text });
    }

    closeSession(sessionId: string): Promise<{ closed: boolean }> {
        return this.request('session.close', { session_id: sessionId });
    }

    /** Drain notifications received so far, in order. */
    drainEvents(): EngineEvent[] {
        return this.queue.splice(0, this.queue.length);
    }

    async stop(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.request('shutdown');
        } catch {
            // The engine already ended; the exit handler reconciles the rest.
        }
        this.child.stdin.end();
        const child = this.child;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                resolve();
            }, 3000);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}
