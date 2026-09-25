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

/**
 * The session channel on the byokit link, falling back to the relay transport.
 *
 * A self-host machine serves the link beside its relay (step 1), so this
 * client dials the link first from the keys the phone already stores — no
 * re-pairing. The relay transport is not built until the link cannot serve
 * the session: it never came online, went down for longer than the grace
 * window, refused a request the link cannot carry (remote desktop), or the
 * host said not-paired.
 *
 * A host's not-paired is deliberately never treated as the truth about the
 * device: it can mean revocation, or a host that has not finished enrolling
 * this device yet. The phone must never be told it was removed while its
 * admission is merely pending, so this client stays silent and lets the relay
 * transport decide — it reports a real revocation itself. No byokit device
 * store is passed either, so a link status can never clear the stored grant.
 */
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
        return this.inner !== undefined ? this.inner.state : this.stateField;
    }
    private stateField: ConnectionState = 'closed';

    connect(): void {
        if (this.closed) return;
        if (this.inner !== undefined) {
            this.inner.connect();
            return;
        }
        if (this.link !== undefined) return;
        const grant = deriveLinkGrant(this.options.hostedGrant);
        if (grant === undefined) {
            this.startRelay();
            return;
        }
        this.setState('connecting');
        this.link = new DeviceLink(grant, {
            timeoutMs: 5_000,
            onStatus: (status) => this.onLinkStatus(status),
            onEvent: (event) => this.onLinkEvent(event),
            // Dial retries are the link's normal state, not failures to log.
            onError: () => undefined,
        });
        this.armFallback(LINK_TRIAL_MS);
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
        return this.inner !== undefined ? this.inner.isLive() : this.online;
    }

    /** Which transport is serving the session; diagnostics and tests read this. */
    get transport(): 'link' | 'relay' | 'closed' {
        if (this.inner !== undefined) return 'relay';
        return this.link !== undefined ? 'link' : 'closed';
    }

    request<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>> {
        if (this.inner !== undefined) return this.inner.request(type, params, timeoutMs);
        const link = this.link;
        if (link === undefined || this.closed) return Promise.reject(new Error('not connected'));
        const frame = { type, requestId: nextRequestId('rn'), params } as ClientRequest;
        const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 20_000;
        return link.request(type, frame, { timeoutMs: timeout }).then(
            (value) => this.unwrap(type, value),
            (cause: unknown) => Promise.reject(this.mapLinkFailure(type, cause)),
        );
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
        if (this.closed || this.inner !== undefined) return;
        if (status === 'online') {
            this.clearFallbackTimer();
            this.online = true;
            this.setState('open');
            return;
        }
        // 'removed' covers a revoked device and a host that has not admitted
        // this device yet; the relay transport, not this client, tells the user
        // which one it was. 'refused' means nothing answered as our host.
        if (status === 'removed' || status === 'refused') {
            this.startRelay();
            return;
        }
        if (this.online) {
            this.online = false;
            this.setState('connecting');
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
            // Only remote desktop produces these today, and only the link
            // refuses it: move the session back to the transport that
            // carries it instead of showing "use the existing relay
            // connection" while none exists.
            this.startRelay();
            return linkRequestFailure(type, cause.message);
        }
        if (cause instanceof LinkError) {
            if (cause.code === 'timeout' || cause.code === 'stopped' || cause.code === 'removed') {
                // The link could not serve the session; the relay transport takes it from here.
                this.startRelay();
                return new Error('connection lost');
            }
            return linkRequestFailure(type, LINK_WORDS[cause.code]);
        }
        return cause instanceof Error ? cause : new Error(String(cause));
    }

    private startRelay(): void {
        if (this.closed || this.inner !== undefined) return;
        this.clearFallbackTimer();
        this.stopLink();
        this.online = false;
        const relay = new MuxrClient(this.options);
        relay.onStateChange((state) => this.setState(state));
        relay.onEvent((sessionId, event) => {
            for (const listener of this.eventListeners) listener(sessionId, event);
        });
        relay.onPluginsInvalidated((frame) => {
            for (const listener of this.pluginListeners) listener(frame);
        });
        this.inner = relay;
        this.setState('connecting');
        relay.connect();
    }

    private stopLink(): void {
        const link = this.link;
        this.link = undefined;
        link?.stop();
    }

    private armFallback(ms: number): void {
        this.clearFallbackTimer();
        this.fallbackTimer = setTimeout(() => {
            this.fallbackTimer = undefined;
            this.startRelay();
        }, ms);
    }

    private clearFallbackTimer(): void {
        if (this.fallbackTimer === undefined) return;
        clearTimeout(this.fallbackTimer);
        this.fallbackTimer = undefined;
    }

    private setState(state: ConnectionState): void {
        if (state === this.stateField) return;
        this.stateField = state;
        for (const listener of this.stateListeners) listener(state);
    }
}
