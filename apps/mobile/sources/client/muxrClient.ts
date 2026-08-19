/**
 * React Native relay client. Uses the global WebSocket (RN + web), never `ws`.
 *
 * Owns transport + request correlation only. All session truth comes from the
 * host; this class never invents domain state.
 */

import { createPayloadCodec, type PayloadCodec } from '@muxr/crypto';
import {
    decodePayload,
    encodePayload,
    nextRequestId,
    normalizeRequestFailure,
    requestRequiresE2ee,
    type ClientFrame,
    type ClientRequest,
    type Envelope,
    type HostFrame,
    type RequestParams,
    type RequestResult,
    type RequestType,
    type SessionEvent,
    issueWsTicket,
    isPluginsInvalidatedFrame,
    ticketSocketUrl,
    WsTicketError,
} from '@muxr/contract';
import { DeviceV2Crypto, refreshHostedGrant, type StoredHostedGrant } from '@/state/hostedE2ee';

/** `stale`: socket is up but the host stopped answering requests (host process gone). */
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'stale';

export interface MuxrClientOptions {
    mode: 'hosted' | 'local';
    relayUrl: string;
    machineId: string;
    requestTimeoutMs?: number;
    reconnectDelayMs?: number;
    /** base64 shared key from @muxr/crypto. Absent = cleartext (explicit opt-in). */
    sharedKey?: string;
    /** Account token. Required by a strict relay, which is any remote one. */
    token?: string;
    hostedGrant?: StoredHostedGrant;
    /** A ticket refusal triggers separate account-session validation; it is not itself a logout signal. */
    onTicketRejected?: () => void;
    /** Permanent self-host credential failures must stop retrying and offer pairing again. */
    onPermanentError?: (message: string) => void;
}

interface Pending {
    resolve: (value: unknown) => void;
    channel: 'session' | 'attachment';
    requestType: RequestType;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Parseable request failure retained across old/new host contract skew. */
export class MuxrRequestError extends Error {
    constructor(message: string, readonly code?: string) {
        super(message);
        this.name = 'MuxrRequestError';
    }
}

function requestFailure(type: RequestType, error: string, code?: string): MuxrRequestError {
    const normalized = normalizeRequestFailure(type, error, code);
    return new MuxrRequestError(normalized.message, normalized.code);
}

type EventListener = (sessionId: string, event: SessionEvent) => void;
type StateListener = (state: ConnectionState) => void;
type PluginInvalidationListener = (frame: Extract<HostFrame, { type: 'plugins.invalidated' }>) => void;

export class MuxrClient {
    private socket: WebSocket | undefined;
    private readonly pending = new Map<string, Pending>();
    private readonly eventListeners = new Set<EventListener>();
    private readonly stateListeners = new Set<StateListener>();
    private readonly pluginInvalidationListeners = new Set<PluginInvalidationListener>();
    private readonly codec: PayloadCodec;
    private hosted: DeviceV2Crypto | undefined;
    private seq = 0;
    private closed = false;
    private readonly clientId = nextRequestId('client');
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private reconnectAttempt = 0;

    state: ConnectionState = 'closed';

    constructor(private readonly options: MuxrClientOptions) {
        if (options.mode === 'hosted' && options.hostedGrant === undefined) throw new Error('hosted connection requires a verified machine grant');
        if (options.mode === 'hosted' && options.sharedKey !== undefined) throw new Error('hosted connection rejects legacy shared keys');
        this.codec = createPayloadCodec(options.sharedKey);
        this.hosted = options.hostedGrant === undefined ? undefined : new DeviceV2Crypto(options.hostedGrant);
    }

    get e2eeEnabled(): boolean {
        return this.hosted !== undefined || this.codec.enabled;
    }

    connect(): void {
        void this.open();
    }

    private async open(): Promise<void> {
        if (this.closed) return;
        this.setState('connecting');
        const { machineId, token } = this.options;
        let relayUrl = this.options.relayUrl;
        let url: string;
        try {
            if (this.options.mode === 'hosted') {
                const latest = await refreshHostedGrant(machineId, token);
                if (latest !== undefined && latest.keyVersion >= (this.hosted?.grant.keyVersion ?? 0)) {
                    if (latest.expiresAt <= Date.now()) throw new Error('hosted device grant expired; pair this browser again');
                    this.hosted = new DeviceV2Crypto(latest);
                    relayUrl = latest.relayUrl;
                }
            }
            if (this.options.mode === 'hosted' && (!token || this.hosted === undefined)) throw new Error('hosted connection is missing its credential or grant');
            const legacyToken = this.options.mode === 'local' && token?.startsWith('acctok_') === true;
            url = token === undefined || token === '' || legacyToken
                ? `${relayUrl}?role=client&machineId=${encodeURIComponent(machineId)}${token === undefined || token === '' ? '' : `&token=${encodeURIComponent(token)}`}`
                : ticketSocketUrl(relayUrl, await issueWsTicket({
                    relayUrl,
                    credential: token,
                    machineId,
                    role: 'client',
                    transport: 'relay',
                }), 'relay');
        } catch (error) {
            const rejected = error instanceof WsTicketError && (error.status === 401 || error.status === 403);
            const expired = error instanceof Error && /grant expired/i.test(error.message);
            const permanent = expired || rejected && this.hosted?.grant.source === 'selfhost';
            this.setState(permanent ? 'stale' : 'closed');
            if (rejected) this.options.onTicketRejected?.();
            if (permanent) {
                this.options.onPermanentError?.(expired
                    ? 'This browser grant expired. Pair again from `muxr pair --browser`.'
                    : 'This device was revoked. Run `muxr pair` on the machine, then re-pair from Settings → Pair another machine on this device.');
                return;
            }
            if (!this.closed) {
                const base = this.options.reconnectDelayMs ?? 1500;
                const delay = error instanceof WsTicketError && (error.status === 401 || error.status === 403)
                    ? 30_000
                    : Math.min(base * 2 ** this.reconnectAttempt++, 30_000);
                this.reconnectTimer = setTimeout(() => this.connect(), delay);
            }
            return;
        }
        const socket = new WebSocket(url);
        this.socket = socket;

        socket.onopen = () => {
            this.reconnectAttempt = 0;
            // The relay accepts a client peer even when no machine is attached,
            // so socket open is not "connected". Stay `connecting` until the
            // first authenticated host frame arrives (handleMessage flips it);
            // the host answers client.hello immediately when it is alive.
            this.send({ type: 'client.hello', clientId: this.clientId });
        };
        socket.onmessage = (message: MessageEvent) => { void this.handleMessage(String(message.data)); };
        socket.onerror = () => socket.close();
        socket.onclose = () => {
            this.setState('closed');
            if (this.closed) return;
            const base = this.options.reconnectDelayMs ?? 1500;
            this.reconnectTimer = setTimeout(() => this.connect(), Math.min(base * 2 ** this.reconnectAttempt++, 30_000));
        };
    }

    close(): void {
        this.closed = true;
        if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('client closed'));
        }
        this.pending.clear();
        this.socket?.close();
    }

    onEvent(listener: EventListener): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    onStateChange(listener: StateListener): () => void {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }

    onPluginsInvalidated(listener: PluginInvalidationListener): () => void {
        this.pluginInvalidationListeners.add(listener);
        return () => this.pluginInvalidationListeners.delete(listener);
    }

    request<T extends RequestType>(type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>> {
        return new Promise<RequestResult<T>>((resolve, reject) => {
            if (requestRequiresE2ee(type) && !this.e2eeEnabled && this.options.mode !== 'local') {
                reject(new MuxrRequestError(`${type} requires an authenticated encrypted channel`, 'e2ee-required'));
                return;
            }
            if (this.socket === undefined || this.socket.readyState !== 1) {
                reject(new Error('not connected'));
                return;
            }
            const requestId = nextRequestId('rn');
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                // Demote from `connecting` too: the relay accepts the socket
                // with no machine attached, and only an answered request ever
                // proves otherwise — otherwise the app pins on "connecting"
                // forever. `closed` is excluded; onclose already owns that.
                if (this.state !== 'closed') this.setState('stale');
                // Overwhelmingly the cause is a machineId mismatch: the relay
                // buffers frames for a machine that never connects, so the
                // request just never comes back. Name the id being addressed.
                reject(new Error(
                    `request timed out: ${type} (no reply from machine "${this.options.machineId}" — `
                    + `is the host running with MUXR_MACHINE_ID=${this.options.machineId}?)`,
                ));
            }, timeoutMs ?? this.options.requestTimeoutMs ?? 20000);

            this.pending.set(requestId, {
                resolve: (value) => resolve(value as RequestResult<T>),
                channel: type === 'attachment.read' ? 'attachment' : 'session',
                requestType: type,
                reject,
                timer,
            });

            const sessionId =
                typeof params === 'object' && params !== null && 'sessionId' in params
                    ? String((params as { sessionId: unknown }).sessionId)
                    : undefined;
            this.send({ type, requestId, params } as ClientRequest, sessionId);
        });
    }

    private send(frame: ClientFrame, sessionId?: string): void {
        this.seq += 1;
        const streamId = sessionId ?? 'machine';
        const channel = frame.type === 'attachment.read' ? 'attachment' : 'session';
        const sealed = this.hosted?.seal(channel, streamId, encodePayload(frame));
        const envelope: Envelope = {
            header: {
                machineId: this.options.machineId,
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(sealed === undefined ? {} : {
                    senderId: this.hosted!.grant.deviceId,
                    recipientId: this.options.machineId,
                    channel,
                    streamId,
                    keyVersion: this.hosted!.grant.keyVersion,
                }),
                seq: sealed?.sequence ?? this.seq,
                at: Date.now(),
            },
            payload: sealed?.payload ?? this.codec.encode(encodePayload(frame)),
        };
        this.socket?.send(JSON.stringify(envelope));
    }

    private async handleMessage(raw: string): Promise<void> {
        let envelope: Envelope;
        try {
            envelope = JSON.parse(raw) as Envelope;
        } catch {
            return;
        }
        let frame: HostFrame;
        try {
            if (envelope.header.machineId !== this.options.machineId) throw new Error('hosted e2ee: routing machine mismatch');
            const streamId = envelope.header.streamId ?? envelope.header.sessionId ?? 'machine';
            const plaintext = this.hosted === undefined
                ? this.codec.decode(envelope.payload)
                : (() => {
                    const channel = envelope.header.channel;
                    if (envelope.header.senderId !== this.options.machineId || envelope.header.recipientId !== '*'
                        || (channel !== 'session' && channel !== 'attachment') || envelope.header.streamId !== streamId
                        || envelope.header.keyVersion !== this.hosted?.grant.keyVersion) {
                        throw new Error('hosted e2ee: invalid routing context');
                    }
                    return this.hosted.open(channel, streamId, envelope.payload, envelope.header.seq);
                })();
            frame = decodePayload<HostFrame>(await plaintext);
        } catch {
            return;
        }

        // Socket open only proves the relay accepted us; the first frame that
        // survives the machine's E2EE context proves the host is really there.
        if (this.state !== 'open') this.setState('open');

        if (frame.type === 'result') {
            const pending = this.pending.get(frame.requestId);
            if (pending === undefined) return;
            if (this.hosted !== undefined && envelope.header.channel !== pending.channel) return;
            clearTimeout(pending.timer);
            this.pending.delete(frame.requestId);
            if (frame.ok) pending.resolve(frame.data);
            else pending.reject(requestFailure(pending.requestType, frame.error, frame.code));
            return;
        }

        if (this.hosted !== undefined && envelope.header.channel !== 'session') return;
        if (isPluginsInvalidatedFrame(frame)) {
            for (const listener of this.pluginInvalidationListeners) listener(frame);
            return;
        }
        if (frame.type === 'session.event') {
            for (const listener of this.eventListeners) listener(frame.sessionId, frame.event);
        }
    }

    private setState(state: ConnectionState): void {
        this.state = state;
        for (const listener of this.stateListeners) listener(state);
    }
}
