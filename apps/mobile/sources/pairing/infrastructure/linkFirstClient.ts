import { DeviceLink, LINK_WORDS, LinkError, PublicLinkError, type LinkStatus } from '@byokit/link';
import { describeRoute } from '@byokit/ui-core/route';
import {
    checkHostProtocol,
    isPluginsInvalidatedFrame,
    nextRequestId,
    normalizeRequestFailure,
    type ClientRequest,
    type HostFrame,
    type LifecycleNotificationLevel,
    type MachineHello,
    type RequestParams,
    type RequestResult,
    type RequestType,
    type SessionEvent,
} from '@trymuxr/contract';
import { deriveLinkGrant } from './linkGrant';
import { sshRelayUrl, stopSshTunnel, SshConnectionError } from '@/connection/sshTunnel';
import type { SshTarget } from '@/connection';
import type { StoredHostedGrant } from '../application/linkPairing';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'stale';

export interface LinkClientOptions {
    hostedGrant?: StoredHostedGrant;
    ssh?: SshTarget;
    requestTimeoutMs?: number;
    /** Heartbeat interval; the link's own default when unset. */
    pingMs?: number;
    onPermanentError?: (message: string) => void;
}

export class MuxrRequestError extends Error {
    constructor(message: string, readonly code?: string) {
        super(message);
        this.name = 'MuxrRequestError';
    }
}

/** The link session port consumed by catalog sync. */
export type SessionClient = {
    readonly state: ConnectionState;
    /** True when this device has a byokit link (enrolled native device): the
     *  one-shot transport for terminal panes, even while it is down. */
    readonly linkCapable: boolean;
    connect(): void;
    close(): void;
    isLive(): boolean;
    request<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>>;
    onStateChange(listener: (state: ConnectionState) => void): () => void;
    onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void;
    onPluginsInvalidated(listener: (frame: Extract<HostFrame, { type: 'plugins.invalidated' }>) => void): () => void;
    registerPush(token: string, level: LifecycleNotificationLevel): Promise<boolean>;
    unregisterPush(): Promise<boolean>;
    terminalStream?(args: Record<string, unknown>): Promise<ByteStreamTransport | undefined>;
    voiceStream?(args: Record<string, unknown>): Promise<ByteStreamTransport | undefined>;
    closeDesktopSignaling?(): void;
};

/** Line-framed duplex stream used by terminal and realtime adapters. */
export type ByteStreamTransport = {
    write(line: string): Promise<void>;
    onLine(listener: (line: string) => void): () => void;
    onEnd(listener: (error?: string) => void): () => void;
    close(): void;
};

type DesktopLinkTransport = {
    request<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>>;
    close(): void;
};

function linkRequestFailure(type: RequestType, error: string, code?: string): MuxrRequestError {
    const normalized = normalizeRequestFailure(type, error, code);
    return new MuxrRequestError(normalized.message, normalized.code);
}

function protocolMismatchMessage(reason: 'host-too-old' | 'host-too-new', hostVersion: string | undefined): string {
    const computer = hostVersion !== undefined && /^\d+\.\d+\.\d+/.test(hostVersion) ? `muxr ${hostVersion}` : 'muxr';
    return reason === 'host-too-old'
        ? `Update needed: Your computer runs ${computer}, which is too old for this app. Update muxr on the computer, then reconnect.`
        : `Update needed: Your computer runs ${computer}, which is newer than this app supports. Update the app, then reconnect.`;
}

/** Actionable offline copy per route, built muxr-side. The kit's
 *  `describeRoute` labels name the transport ("Local or private network")
 *  but never form a sentence, so they must not be interpolated into one. */
export function hostUnreachableMessage(route: string | undefined, computer: string): string {
    if (route === 'Tailscale')
        return `Can't reach ${computer}. Is it awake and is Tailscale connected on this phone and the computer?`;
    if (route === 'Private network')
        return `Can't reach ${computer}. Is it awake and on the same private network as this phone?`;
    if (route === 'Cloudflare tunnel')
        return `Can't reach ${computer}. Is it awake and is its Cloudflare tunnel running?`;
    if (route === 'Hosted VPS / custom relay')
        return `Can't reach ${computer}. Is it awake and online?`;
    if (route === 'Local or private network')
        return `Can't reach ${computer}. Is it awake and on the same Wi-Fi as this phone?`;
    return `Can't reach ${computer}. Is it awake and online?`;
}

/** The relay answers but the computer is not attached to it: wake the
 *  computer rather than re-checking this phone's connection. */
export function relayWithoutHostMessage(computer: string): string {
    return `Can't reach ${computer}: its muxr relay is online, but the computer is not connected. Wake the computer and make sure muxr is running there; if this device was removed, pair again.`;
}

/** One byokit link, including its terminal, desktop, voice and push streams. */
export class LinkFirstClient implements SessionClient {
    private link: DeviceLink | undefined;
    /** The byokit link is the only transport for this client (one-shot migration). */
    get linkCapable(): boolean {
        return deriveLinkGrant(this.options.hostedGrant) !== undefined;
    }
    private online = false;
    private closed = false;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private retryAttempt = 0;
    private lastHealthCheck = 0;
    private healthGeneration = 0;
    private handshake = 0;
    private lastPush: { token: string; level: LifecycleNotificationLevel } | undefined;
    private readonly stateListeners = new Set<(state: ConnectionState) => void>();
    private readonly eventListeners = new Set<(sessionId: string, event: SessionEvent) => void>();
    private readonly pluginListeners = new Set<(frame: Extract<HostFrame, { type: 'plugins.invalidated' }>) => void>();
    private desktopTransport: DesktopLinkTransport | undefined;
    private desktopOpening: Promise<DesktopLinkTransport | undefined> | undefined;

    constructor(private readonly options: LinkClientOptions) {}

    get state(): ConnectionState {
        return this.stateField;
    }
    private stateField: ConnectionState = 'closed';

    connect(): void {
        if (this.closed || this.link !== undefined || this.stateField === 'stale') return;
        const stored = this.options.hostedGrant;
        if (stored?.credential) {
            this.setState('stale');
            this.options.onPermanentError?.('Pair again: This phone was paired before muxr changed its connection protocol; pair again with this computer.');
            return;
        }
        const grant = deriveLinkGrant(stored);
        if (stored === undefined || grant === undefined) {
            this.setState('stale');
            this.options.onPermanentError?.('Pair again: This computer no longer recognises this pairing.');
            return;
        }
        this.link = new DeviceLink(grant, {
            // Covers socket open, Noise handshake and the host's `ready` together:
            // a starved host needs far longer than a relay round trip.
            timeoutMs: 20_000,
            ...(this.options.pingMs === undefined ? {} : { pingMs: this.options.pingMs }),
            ...(this.options.ssh === undefined ? {} : { resolve: async (url: string) => {
                try { return await sshRelayUrl(url, stored.machineId, this.options.ssh!); }
                catch (error) {
                    if (error instanceof SshConnectionError && error.permanent) {
                        this.stopLink();
                        this.setState('stale', true);
                        this.options.onPermanentError?.(error.message);
                    }
                    throw error;
                }
            } }),
            onStatus: (status) => this.onLinkStatus(status),
            onEvent: (event) => this.onLinkEvent(event),
            onError: () => undefined,
        });
        this.setState('connecting');
    }

    close(): void {
        this.closed = true;
        this.healthGeneration++;
        if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
        this.stopLink();
        if (this.options.ssh !== undefined) void stopSshTunnel();
        this.setState('closed');
    }

    isLive(): boolean {
        return this.online;
    }

    get transport(): 'link' | 'closed' {
        return this.online ? 'link' : 'closed';
    }

    request<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>> {
        if (this.closed) return Promise.reject(new Error('not connected'));
        if (type.startsWith('desktop.')) return this.requestViaLink(type, params, timeoutMs);
        const link = this.link;
        if (link === undefined) return Promise.reject(new Error('link unavailable; retry when connected'));
        const frame = { type, requestId: nextRequestId('rn'), params } as ClientRequest;
        const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 20_000;
        return link.request(type, frame, { timeoutMs: timeout }).then(
            (value) => this.unwrap(type, value),
            (cause: unknown) => Promise.reject(this.mapLinkFailure(type, cause)),
        );
    }

    /** Opens a terminal or voice stream over the link. */
    private async openByteStream(name: 'terminal' | 'voice' | 'plugin', args: Record<string, unknown>): Promise<ByteStreamTransport | undefined> {
        if (!this.online || this.link === undefined || this.closed) return undefined;
        const stream = await this.link.stream(name, args);
        let ended = false;
        let endError: string | undefined;
        const lines = new Set<(line: string) => void>();
        const ends = new Set<(error?: string) => void>();
        const early: string[] = [];
        let earlySize = 0;
        const decoder = new TextDecoder();
        let buffer = '';
        const finish = (error?: string): void => {
            if (ended) return;
            ended = true;
            endError = error;
            for (const listener of [...ends]) listener(error);
        };
        stream.onData = (chunk) => {
            if (ended) return;
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.length > 1_048_576) {
                finish('terminal: link frame too large');
                stream.end();
                return;
            }
            const parts = buffer.split('\n');
            buffer = parts.pop() ?? '';
            for (const line of parts) {
                if (ended) break;
                if (lines.size > 0) {
                    for (const listener of [...lines]) listener(line);
                } else {
                    earlySize += line.length;
                    if (earlySize > 1_048_576) {
                        finish('terminal: link input too large');
                        stream.end();
                    } else early.push(line);
                }
            }
        };
        stream.onEnd = finish;
        return {
            // The link is a byte stream, not messages: every line carries its own newline.
            write: (line) => stream.write(`${line}\n`),
            onLine: (listener) => {
                lines.add(listener);
                for (const line of early.splice(0)) listener(line);
                earlySize = 0;
                return () => { lines.delete(listener); };
            },
            onEnd: (listener) => {
                if (ended) listener(endError);
                else ends.add(listener);
                return () => { ends.delete(listener); };
            },
            close: () => {
                finish();
                stream.end();
            },
        };
    }

    /** Opens the realtime voice stream while the link serves the session. */
    voiceStream(args: Record<string, unknown>): Promise<ByteStreamTransport | undefined> {
        return this.openByteStream('voice', args);
    }

    /** Opens the pane's stream while the link serves the session. */
    terminalStream(args: Record<string, unknown>): Promise<ByteStreamTransport | undefined> {
        return this.openByteStream('terminal', args);
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
        const handshake = ++this.handshake;
        if (status === 'online') {
            this.healthGeneration++;
            this.retryAttempt = 0;
            void this.admitHost(this.link, handshake);
            return;
        }
        if (status === 'removed') {
            this.healthGeneration++;
            const wasOnline = this.online;
            this.stopLink();
            this.setState('stale', true);
            this.options.onPermanentError?.(wasOnline
                ? 'Access removed: This computer revoked this device. Pair again to restore access.'
                : 'Pair again: This computer no longer recognises this pairing (it may have been removed).');
            return;
        }
        if (status === 'refused') {
            this.stopLink();
            this.setState('stale', true);
            void this.checkHealth(true);
            return;
        }
        if (status === 'offline' && Date.now() - this.lastHealthCheck > 10_000) void this.checkHealth();
        if (this.online) {
            this.online = false;
            this.setState('connecting', true);
        }
    }

    /** The link is up; open it only to a host whose protocol this app speaks. */
    private async admitHost(link: DeviceLink, handshake: number): Promise<void> {
        let hello: MachineHello | undefined;
        // A host that predates the handshake cannot answer: it speaks the baseline protocol.
        try { hello = await this.request('machine.hello', {}, 5_000); } catch { hello = undefined; }
        if (this.closed || this.link !== link || handshake !== this.handshake) return;
        const compatibility = checkHostProtocol(hello);
        if (!compatibility.ok) {
            this.stopLink();
            this.setState('stale', true);
            this.options.onPermanentError?.(protocolMismatchMessage(compatibility.reason, hello?.hostVersion));
            return;
        }
        this.online = true;
        this.setState('open', true);
        // The registration may have ridden the relay HTTP API while the link
        // was down; re-register here so one device lives in one push store.
        if (this.lastPush !== undefined) {
            void this.registerPush(this.lastPush.token, this.lastPush.level).catch(() => undefined);
        }
    }

    private async checkHealth(refused = false): Promise<void> {
        const stored = this.options.hostedGrant;
        if (stored === undefined || this.closed) return;
        this.lastHealthCheck = Date.now();
        const generation = this.healthGeneration;
        const route = describeRoute(stored.relayUrl);
        // The grant's pairing name, never the internal machine id.
        const computer = stored.machineName ?? 'your computer';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        let message: string;
        let permanent = false;
        try {
            const relay = new URL(stored.relayUrl);
            relay.protocol = relay.protocol === 'wss:' ? 'https:' : 'http:';
            relay.pathname = '/health';
            relay.search = '';
            const response = await fetch(relay.toString(), { signal: controller.signal });
            const health = await response.json() as { ok?: unknown; muxrVersion?: unknown; linkProtocol?: unknown };
            if (!response.ok || health.ok !== true) throw new Error('not a muxr relay');
            const hostVersion = typeof health.muxrVersion === 'string' ? health.muxrVersion : undefined;
            message = relayWithoutHostMessage(computer);
            if (health.linkProtocol !== 1) {
                message = 'Update needed: This computer runs an older muxr connection protocol. Update muxr on the computer, then pair again.';
                permanent = true;
            } else if (refused && hostVersion && /^\d+\.\d+\.\d+/.test(hostVersion)) {
                // Differing versions only explain a refusal. A relay that answers while
                // the link is merely offline is a host coming back, and machine.hello
                // re-checks its protocol on the next handshake.
                const { getAppVersion } = await import('@/utils/appVersion');
                const app = getAppVersion();
                if (/^\d+\.\d+\.\d+/.test(app) && hostVersion.split(/[-+]/)[0] !== app.split(/[-+]/)[0]) {
                    const comparison = (version: string) => version.split(/[.+-]/).slice(0, 3).map(Number);
                    const hostParts = comparison(hostVersion);
                    const appParts = comparison(app);
                    const newer = hostParts.findIndex((part, index) => part !== appParts[index]);
                    message = newer >= 0 && hostParts[newer]! > appParts[newer]!
                        ? `Update needed: Your computer runs muxr ${hostVersion}; this app (${app}) needs an update. Update the app, then pair again.`
                        : `Update needed: Your computer runs muxr ${hostVersion}; this app runs ${app}. Update muxr on the computer, then pair again.`;
                    permanent = true;
                }
            }
        } catch {
            message = hostUnreachableMessage(route, computer);
        } finally {
            clearTimeout(timer);
        }
        if (this.closed || this.online || generation !== this.healthGeneration) return;
        if (permanent) this.stopLink();
        this.setState(permanent ? 'stale' : 'closed', true);
        this.options.onPermanentError?.(message);
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
        if (cause instanceof PublicLinkError) return linkRequestFailure(type, cause.message);
        if (cause instanceof LinkError) {
            if (cause.code === 'not-supported' || cause.code === 'unsupported') {
                this.stopLink();
                this.setState('stale', true);
                this.options.onPermanentError?.('Update needed: Update muxr on the computer, then pair again.');
                return new Error('update muxr and pair again');
            }
            if (cause.code === 'removed' || cause.code === 'not-paired' || cause.code === 'ended') {
                const wasOnline = this.online;
                this.stopLink();
                this.setState('stale', true);
                this.options.onPermanentError?.(wasOnline && cause.code === 'removed'
                    ? 'Access removed: This computer revoked this device. Pair again to restore access.'
                    : 'Pair again: This computer no longer recognises this pairing (it may have been removed).');
                return new Error('pair with this computer again');
            }
            if (cause.code === 'stopped') {
                this.stopLink();
                this.scheduleRetry();
                return new Error('connection lost');
            }
            return linkRequestFailure(type, LINK_WORDS[cause.code]);
        }
        return cause instanceof Error ? cause : new Error(String(cause));
    }

    private scheduleRetry(): void {
        if (this.closed || this.retryTimer !== undefined) return;
        const delay = Math.min(1000 * 2 ** Math.min(this.retryAttempt++, 4), 10_000);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.connect();
        }, delay);
    }

    private stopLink(): void {
        const link = this.link;
        this.link = undefined;
        this.desktopTransport?.close();
        this.desktopTransport = undefined;
        const wasOnline = this.online;
        this.online = false;
        link?.stop();
        if (!this.closed) this.setState('connecting', wasOnline);
    }

    private setState(state: ConnectionState, transportChanged = false): void {
        if (state === this.stateField && !transportChanged) return;
        this.stateField = state;
        for (const listener of this.stateListeners) listener(state);
    }
}
