import { DeviceLink, LINK_WORDS, LinkError, PublicLinkError, type LinkStatus } from '@byokit/link';
import {
    isPluginsInvalidatedFrame,
    nextRequestId,
    normalizeRequestFailure,
    type ClientRequest,
    type HostFrame,
    type LifecycleNotificationLevel,
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
    closeDesktopSignaling?(): void;
    registerPush(token: string, level: LifecycleNotificationLevel): Promise<boolean>;
    unregisterPush(): Promise<boolean>;
    terminalStream?(args: Record<string, unknown>): Promise<ByteStreamTransport | undefined>;
    voiceStream?(args: Record<string, unknown>): Promise<ByteStreamTransport | undefined>;
};

export type ByteStreamTransport = {
    write(line: string): Promise<void>;
    onLine(listener: (line: string) => void): () => void;
    onEnd(listener: (error?: string) => void): () => void;
    close(): void;
};

export type TerminalLinkTransport = ByteStreamTransport;

type DesktopLinkTransport = {
    request<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>>;
    close(): void;
};

function linkRequestFailure(type: RequestType, error: string, code?: string): MuxrRequestError {
    const normalized = normalizeRequestFailure(type, error, code);
    return new MuxrRequestError(normalized.message, normalized.code);
}

export class LinkFirstClient implements SessionClient {
    private inner: MuxrClient | undefined;
    private link: DeviceLink | undefined;
    private online = false;
    private closed = false;
    private lastPush: { token: string; level: LifecycleNotificationLevel } | undefined;
    private readonly stateListeners = new Set<(state: ConnectionState) => void>();
    private readonly eventListeners = new Set<(sessionId: string, event: SessionEvent) => void>();
    private readonly pluginListeners = new Set<(frame: Extract<HostFrame, { type: 'plugins.invalidated' }>) => void>();
    private desktopTransport: DesktopLinkTransport | undefined;
    private desktopOpening: Promise<DesktopLinkTransport | undefined> | undefined;

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
        this.desktopTransport?.close();
        this.desktopTransport = undefined;
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
        if (type.startsWith('desktop.')) return this.requestViaLink(type, params, timeoutMs);
        if (!this.online) return this.requestViaRelay(type, params, timeoutMs);
        const link = this.link;
        if (link === undefined) return this.requestViaRelay(type, params, timeoutMs);
        const frame = { type, requestId: nextRequestId('rn'), params } as ClientRequest;
        const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 20_000;
        return link.request(type, frame, { timeoutMs: timeout }).then(
            (value) => this.unwrap(type, value),
            (cause: unknown) => Promise.reject(this.mapLinkFailure(type, cause)),
        );
    }

    private requestViaRelay<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>> {
        if (this.closed) return Promise.reject(new Error('not connected'));
        const relay = this.inner;
        if (relay === undefined) return Promise.reject(new Error('not connected'));
        if (relay.isLive()) return relay.request(type, params, timeoutMs);
        return new Promise<RequestResult<T>>((resolve, reject) => {
            const finish = () => { clearTimeout(timer); offRelay(); offState(); };
            const check = () => {
                if (this.closed) { finish(); reject(new Error('not connected')); return; }
                if (!this.online && !relay.isLive()) return;
                finish();
                const request = this.online ? this.request(type, params, timeoutMs) : relay.request(type, params, timeoutMs);
                void request.then(resolve, reject);
            };
            const timer = setTimeout(() => { finish(); reject(new Error('not connected')); }, timeoutMs ?? 10_000);
            const offRelay = relay.onStateChange(check);
            const offState = this.onStateChange(check);
            check();
        });
    }

    private requestViaLink<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>> {
        if (this.closed) return Promise.reject(new Error('not connected'));
        return new Promise<RequestResult<T>>((resolve, reject) => {
            let opening = false;
            let settled = false;
            const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                offState();
            };
            const check = (): void => {
                if (settled) return;
                if (this.closed) { finish(); reject(new Error('not connected')); return; }
                if (!this.online || opening) return;
                opening = true;
                void this.desktopStream().then((transport) => {
                    opening = false;
                    if (settled) return;
                    if (transport === undefined) {
                        if (!this.online) return;
                        finish();
                        reject(new Error('desktop signaling link is unavailable'));
                        return;
                    }
                    finish();
                    void transport.request(type, params, timeoutMs).then(resolve, reject);
                }, (error: unknown) => { finish(); reject(error); });
            };
            const timer = setTimeout(() => { finish(); reject(new Error('desktop signaling link unavailable')); }, timeoutMs ?? this.options.requestTimeoutMs ?? 20_000);
            const offState = this.onStateChange(check);
            check();
        });
    }

    /** One duplex signaling stream for desktop requests; media remains WebRTC. */
    private async desktopStream(): Promise<DesktopLinkTransport | undefined> {
        if (this.desktopTransport !== undefined) return this.desktopTransport;
        if (this.desktopOpening !== undefined) return this.desktopOpening;
        const opening = this.openDesktopStream();
        this.desktopOpening = opening;
        try { return await opening; }
        finally { if (this.desktopOpening === opening) this.desktopOpening = undefined; }
    }

    private async openDesktopStream(): Promise<DesktopLinkTransport | undefined> {
        const link = this.link;
        if (!this.online || link === undefined || this.closed) return undefined;
        let stream: Awaited<ReturnType<DeviceLink['stream']>>;
        try { stream = await link.stream('desktop', {}); }
        catch { return undefined; }
        if (this.closed || this.link !== link || !this.online) { stream.end(); return undefined; }
        let ended = false;
        let buffer = '';
        const decoder = new TextDecoder();
        let transport: DesktopLinkTransport;
        const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
        const failPending = (error: Error): void => {
            for (const request of pending.values()) {
                clearTimeout(request.timer);
                request.reject(error);
            }
            pending.clear();
        };
        stream.onData = (chunk) => {
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.length > 1_000_000) { stream.end('desktop response too large'); return; }
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                let frame: unknown;
                try { frame = JSON.parse(line); } catch { stream.end('malformed desktop response'); return; }
                if (typeof frame !== 'object' || frame === null || !('requestId' in frame) || typeof frame.requestId !== 'string') continue;
                const request = pending.get(frame.requestId);
                if (request === undefined) continue;
                pending.delete(frame.requestId);
                clearTimeout(request.timer);
                request.resolve(frame);
            }
        };
        stream.onEnd = (error) => {
            if (ended) return;
            ended = true;
            failPending(new Error(error ?? 'desktop signaling stream ended'));
            if (this.desktopTransport === transport) this.desktopTransport = undefined;
        };
        transport = {
            request: async <T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>> => {
                if (ended || !this.online || this.link !== link) return this.requestViaLink(type, params, timeoutMs);
                const frame = { type, requestId: nextRequestId('rn'), params } as ClientRequest;
                const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 20_000;
                const response = await new Promise<unknown>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        pending.delete(frame.requestId);
                        reject(new Error('desktop signaling request timed out'));
                    }, timeout);
                    pending.set(frame.requestId, { resolve, reject, timer });
                    void stream.write(`${JSON.stringify(frame)}\n`).catch((cause: unknown) => {
                        if (!pending.delete(frame.requestId)) return;
                        clearTimeout(timer);
                        reject(cause instanceof Error ? cause : new Error(String(cause)));
                    });
                });
                return this.unwrap(type, response);
            },
            close: () => {
                if (ended) return;
                ended = true;
                stream.end();
                failPending(new Error('desktop signaling stream closed'));
                if (this.desktopTransport === transport) this.desktopTransport = undefined;
            },
        };
        this.desktopTransport = transport;
        return transport;
    }

    closeDesktopSignaling(): void {
        this.desktopTransport?.close();
        this.desktopTransport = undefined;
    }

    private async openByteStream(name: 'terminal' | 'voice', args: Record<string, unknown>): Promise<ByteStreamTransport | undefined> {
        if (!this.online || this.link === undefined || this.closed) return undefined;
        const stream = await this.link.stream(name, args);
        let ended = false;
        const lines = new Set<(line: string) => void>();
        const ends = new Set<(error?: string) => void>();
        const pendingLines: string[] = [];
        const decoder = new TextDecoder();
        let buffer = '';
        stream.onData = (chunk) => {
            buffer += decoder.decode(chunk, { stream: true });
            const parts = buffer.split('\n');
            buffer = parts.pop() ?? '';
            for (const line of parts) {
                if (lines.size === 0) pendingLines.push(line);
                else for (const listener of [...lines]) listener(line);
            }
        };
        stream.onEnd = (error) => {
            if (ended) return;
            ended = true;
            for (const listener of [...ends]) listener(error);
        };
        return {
            write: (line) => stream.write(`${line}\n`),
            onLine: (listener) => {
                lines.add(listener);
                for (const line of pendingLines.splice(0)) listener(line);
                return () => { lines.delete(listener); };
            },
            onEnd: (listener) => {
                ends.add(listener);
                return () => { ends.delete(listener); };
            },
            close: () => stream.end(),
        };
    }

    voiceStream(args: Record<string, unknown>): Promise<ByteStreamTransport | undefined> {
        return this.openByteStream('voice', args);
    }

    terminalStream(args: Record<string, unknown>): Promise<ByteStreamTransport | undefined> {
        return this.openByteStream('terminal', args);
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

    async registerPush(token: string, level: LifecycleNotificationLevel): Promise<boolean> {
        this.lastPush = { token, level };
        if (this.link === undefined || !this.online) return false;
        await this.request('push.subscribe', { token, level }, 5_000);
        return true;
    }

    async unregisterPush(): Promise<boolean> {
        this.lastPush = undefined;
        if (this.link === undefined || !this.online) return false;
        await this.request('push.unsubscribe', {}, 5_000);
        return true;
    }

    private onLinkStatus(status: LinkStatus): void {
        if (this.closed || this.link === undefined) return;
        if (status === 'online') {
            this.online = true;
            this.setState('open', true);
            if (this.lastPush !== undefined) void this.registerPush(this.lastPush.token, this.lastPush.level).catch(() => undefined);
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
    }

    private stopLink(): void {
        const link = this.link;
        this.link = undefined;
        this.desktopTransport?.close();
        this.desktopTransport = undefined;
        const wasOnline = this.online;
        this.online = false;
        link?.stop();
        if (!this.closed) this.setState(this.inner?.state ?? 'connecting', wasOnline);
    }

    private setState(state: ConnectionState, transportChanged = false): void {
        if (state === this.stateField && !transportChanged) return;
        this.stateField = state;
        for (const listener of this.stateListeners) listener(state);
    }
}
