import { DeviceLink, LINK_WORDS, LinkError, PublicLinkError, type LinkStatus } from '@byokit/link';
import {
    isPluginsInvalidatedFrame,
    nextRequestId,
    normalizeRequestFailure,
    type ClientRequest,
    type HostFrame,
    type RequestParams,
    type RequestResult,
    type RequestType,
    type SessionEvent,
} from '@muxr/contract';
import { deriveLinkGrant } from '../application/linkGrant';
import { MuxrClient, MuxrRequestError, type ConnectionState, type MuxrClientOptions } from './muxrClient';

/** The slice of a session transport the catalog sync drives; `MuxrClient` satisfies it too. */
export type SessionClient = {
    readonly state: ConnectionState;
    connect(): void;
    close(): void;
    isLive(): boolean;
    request<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>>;
    onStateChange(listener: (state: ConnectionState) => void): () => void;
    onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void;
    onPluginsInvalidated(listener: (frame: Extract<HostFrame, { type: 'plugins.invalidated' }>) => void): () => void;
    /** A terminal pane over the link while the link serves the session; undefined when the relay
     *  does. Rejects when the host cannot carry streams, so the pane falls back to the relay. */
    terminalStream?(args: Record<string, unknown>): Promise<TerminalLinkTransport | undefined>;
};

/** One pane's pipe over the link: the same NDJSON frames the relay terminal
 *  channel pipes, whole lines each way. Ended by a link drop -- the pane then
 *  re-attaches (a new stream, or the relay), it is never torn down. */
export type TerminalLinkTransport = {
    /** One client→host NDJSON line. Rejects once the stream has ended. */
    write(line: string): Promise<void>;
    /** Each complete host→client NDJSON line, in order. Returns the unsubscribe. */
    onLine(listener: (line: string) => void): () => void;
    /** The stream ended (link dropped, or the host closed it). */
    onEnd(listener: (error?: string) => void): () => void;
    close(): void;
};

/**
 * How long the link gets to prove itself, and how long an online link may stay
 * down, before this client hands the session to the relay transport. The trial
 * sits above one full failed dial; the grace covers byokit's first backoff
 * rounds so a network blip does not flap the session onto the relay.
 */
const LINK_TRIAL_MS = 6_000;
const LINK_GRACE_MS = 20_000;

function linkRequestFailure(type: RequestType, error: string, code?: string): MuxrRequestError {
    const normalized = normalizeRequestFailure(type, error, code);
    return new MuxrRequestError(normalized.message, normalized.code);
}

export class LinkFirstClient implements SessionClient {
    private inner: MuxrClient | undefined;
    private link: DeviceLink | undefined;
    private online = false;
    private closed = false;
    private fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly stateListeners = new Set<(state: ConnectionState) => void>();
    private readonly eventListeners = new Set<(sessionId: string, event: SessionEvent) => void>();
    private readonly pluginListeners = new Set<(frame: Extract<HostFrame, { type: 'plugins.invalidated' }>) => void>();

    constructor(private readonly options: MuxrClientOptions) {}

    get state(): ConnectionState {
        return this.stateField;
    }
    private stateField: ConnectionState = 'closed';

    connect(): void {
        if (this.closed) return;
        if (this.inner === undefined) this.startRelay();
        else this.inner.connect();
    }

    close(): void {
        this.closed = true;
        this.clearFallbackTimer();
        this.stopLink();
        this.inner?.close();
        this.inner = undefined;
        this.setState('closed');
    }

    isLive(): boolean {
        return this.online || this.inner?.isLive() === true;
    }

    /** Which transport is serving the session; diagnostics and tests read this. */
    get transport(): 'link' | 'relay' | 'closed' {
        if (this.online) return 'link';
        return this.inner !== undefined ? 'relay' : 'closed';
    }

    request<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>> {
        if (this.closed) return Promise.reject(new Error('not connected'));
        const relay = this.inner;
        if (type.startsWith('desktop.') || !this.online) {
            if (relay === undefined) return Promise.reject(new Error('not connected'));
            if (relay.isLive()) return relay.request(type, params, timeoutMs);
            return new Promise<RequestResult<T>>((resolve, reject) => {
                const ready = () => type.startsWith('desktop.') ? relay.isLive() : this.online || relay.isLive();
                const finish = () => { clearTimeout(timer); offRelay(); offState(); };
                const check = () => {
                    if (this.closed) { finish(); reject(new Error('not connected')); return; }
                    if (!ready()) return;
                    finish();
                    void this.request(type, params, timeoutMs).then(resolve, reject);
                };
                const timer = setTimeout(() => { finish(); reject(new Error('not connected')); }, timeoutMs ?? 10_000);
                const offRelay = relay.onStateChange(check);
                const offState = this.onStateChange(check);
                check();
            });
        }
        const link = this.link;
        if (link === undefined || this.closed) return Promise.reject(new Error('not connected'));
        const frame = { type, requestId: nextRequestId('rn'), params } as ClientRequest;
        const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 20_000;
        return link.request(type, frame, { timeoutMs: timeout }).then(
            (value) => this.unwrap(type, value),
            (cause: unknown) => Promise.reject(this.mapLinkFailure(type, cause)),
        );
    }

    /** Opens the pane's stream when the link is serving the session; undefined means the relay does. */
    async terminalStream(args: Record<string, unknown>): Promise<TerminalLinkTransport | undefined> {
        if (!this.online || this.link === undefined || this.closed) return undefined;
        const stream = await this.link.stream('terminal', args);
        let ended = false;
        const lines = new Set<(line: string) => void>();
        const ends = new Set<(error?: string) => void>();
        const decoder = new TextDecoder();
        let buffer = '';
        stream.onData = (chunk) => {
            buffer += decoder.decode(chunk, { stream: true });
            const parts = buffer.split('\n');
            buffer = parts.pop() ?? '';
            for (const line of parts) {
                for (const listener of [...lines]) listener(line);
            }
        };
        stream.onEnd = (error) => {
            if (ended) return;
            ended = true;
            for (const listener of [...ends]) listener(error);
        };
        return {
            // The link is a byte stream, not messages: every line carries its own newline.
            write: (line) => stream.write(`${line}\n`),
            onLine: (listener) => {
                lines.add(listener);
                return () => { lines.delete(listener); };
            },
            onEnd: (listener) => {
                ends.add(listener);
                return () => { ends.delete(listener); };
            },
            close: () => {
                stream.end();
            },
        };
    }

    onStateChange(listener: (state: ConnectionState) => void): () => void {
        this.stateListeners.add(listener);
        return () => { this.stateListeners.delete(listener); };
    }

    onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => { this.eventListeners.delete(listener); };
    }

    onPluginsInvalidated(listener: (frame: Extract<HostFrame, { type: 'plugins.invalidated' }>) => void): () => void {
        this.pluginListeners.add(listener);
        return () => { this.pluginListeners.delete(listener); };
    }

    private onLinkStatus(status: LinkStatus): void {
        if (this.closed || this.link === undefined) return;
        if (status === 'online') {
            this.clearFallbackTimer();
            this.online = true;
            this.setState('open', true);
            return;
        }
        // 'removed' covers a revoked device and a host that has not admitted
        // this device yet; the relay transport, not this client, tells the user
        // which one it was. 'refused' means nothing answered as our host.
        if (status === 'removed' || status === 'refused') {
            this.stopLink();
            return;
        }
        if (this.online) {
            this.online = false;
            this.setState(this.inner?.state ?? 'connecting', true);
            this.armFallback(LINK_GRACE_MS);
        }
    }

    /** Broadcast frames ride the link unsealed-looking but authenticated by its handshake. */
    private onLinkEvent(event: unknown): void {
        if (typeof event !== 'object' || event === null || !('type' in event)) return;
        const frame = event as HostFrame;
        if (frame.type === 'session.event') {
            for (const listener of this.eventListeners) listener(frame.sessionId, frame.event);
            return;
        }
        if (isPluginsInvalidatedFrame(frame)) {
            for (const listener of this.pluginListeners) listener(frame);
        }
    }

    private unwrap<T extends RequestType>(type: T, value: unknown): RequestResult<T> {
        if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'result') {
            const result = value as Extract<HostFrame, { type: 'result' }>;
            if (result.ok) return result.data as RequestResult<T>;
            throw linkRequestFailure(type, String(result.error), typeof result.code === 'string' ? result.code : undefined);
        }
        throw new Error(`unexpected host reply over the link: ${type}`);
    }

    private mapLinkFailure(type: RequestType, cause: unknown): Error {
        if (cause instanceof PublicLinkError) {
            this.stopLink();
            return linkRequestFailure(type, cause.message);
        }
        if (cause instanceof LinkError) {
            if (cause.code === 'timeout' || cause.code === 'stopped' || cause.code === 'removed') {
                // The link could not serve the session; the relay transport takes it from here.
                this.stopLink();
                return new Error('connection lost');
            }
            return linkRequestFailure(type, LINK_WORDS[cause.code]);
        }
        return cause instanceof Error ? cause : new Error(String(cause));
    }

    private startRelay(): void {
        if (this.closed || this.inner !== undefined) return;
        const relay = new MuxrClient({
            ...this.options,
            onLinkEnrolled: (key) => this.onLinkEnrolled(key),
            onHostHello: () => {
                if (this.link === undefined && this.options.hostedGrant?.source === 'selfhost') {
                    void this.inner?.request('herdr.tree', {}).catch(() => undefined);
                }
            },
        });
        relay.onStateChange((state) => { if (!this.online) this.setState(state); });
        relay.onEvent((sessionId, event) => {
            if (!this.online) for (const listener of this.eventListeners) listener(sessionId, event);
        });
        relay.onPluginsInvalidated((frame) => {
            if (!this.online) for (const listener of this.pluginListeners) listener(frame);
        });
        this.inner = relay;
        this.setState('connecting');
        relay.connect();
    }

    private onLinkEnrolled(key: string): void {
        const stored = this.options.hostedGrant;
        if (this.closed || this.link !== undefined || stored?.source !== 'selfhost'
            || stored.deviceKey.publicKey !== key) return;
        const route = this.options.ssh === undefined ? undefined : this.inner?.activeRelayUrl;
        if (this.options.ssh !== undefined && route === undefined) return;
        const grant = deriveLinkGrant(stored, route);
        if (grant === undefined) return;
        this.link = new DeviceLink(grant, {
            timeoutMs: 5_000,
            onStatus: (status) => this.onLinkStatus(status),
            onEvent: (event) => this.onLinkEvent(event),
            onError: () => undefined,
        });
        this.armFallback(LINK_TRIAL_MS);
    }

    private stopLink(): void {
        const link = this.link;
        this.link = undefined;
        const wasOnline = this.online;
        this.online = false;
        link?.stop();
        if (!this.closed) this.setState(this.inner?.state ?? 'connecting', wasOnline);
    }

    private armFallback(ms: number): void {
        this.clearFallbackTimer();
        this.fallbackTimer = setTimeout(() => {
            this.fallbackTimer = undefined;
            this.stopLink();
        }, ms);
    }

    private clearFallbackTimer(): void {
        if (this.fallbackTimer === undefined) return;
        clearTimeout(this.fallbackTimer);
        this.fallbackTimer = undefined;
    }

    private setState(state: ConnectionState, transportChanged = false): void {
        if (state === this.stateField && !transportChanged) return;
        this.stateField = state;
        for (const listener of this.stateListeners) listener(state);
    }
}
