/**
 * React Native relay client. Uses the global WebSocket (RN + web), never `ws`.
 *
 * Owns transport + request correlation only. All session truth comes from the
 * host; this class never invents domain state.
 */

import {
    decodePayload,
    encodePayload,
    nextRequestId,
    normalizeRequestFailure,
    requestRequiresE2ee,
    relayControlUrl,
    routingChannelForRequest,
    type ClientFrame,
    type ClientRequest,
    type Envelope,
    type HostFrame,
    type LifecycleNotificationLevel,
    type RequestParams,
    type RequestResult,
    type RequestType,
    type SessionEvent,
    issueWsTicket,
    isPluginsInvalidatedFrame,
    ticketSocketUrl,
    WsTicketError,
} from '@muxr/contract';
import { DeviceV2Crypto, refreshHostedGrant, type StoredHostedGrant } from '../application/hostedE2ee';
import {
    recordSocketFailure,
    socketCloseReason,
    ticketFailureCode,
    type ConnectionDiagnosticSocketFailureCode,
} from '@/catalog/diagnostics';
import { sshRelayUrl, stopSshTunnel, SshConnectionError } from '@/connection/sshTunnel';
// Type-only: keeps the connection barrel out of this module's runtime graph.
import type { SshTarget } from '@/connection';

/** `stale`: host liveness is unproven because a request timed out without newer authenticated host traffic. */
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'stale';

export interface MuxrClientOptions {
    mode: 'hosted' | 'local';
    relayUrl: string;
    machineId: string;
    requestTimeoutMs?: number;
    reconnectDelayMs?: number;
    /** Account token. Required by a strict relay, which is any remote one. */
    token?: string;
    hostedGrant?: StoredHostedGrant;
    /** Android-only route to the host's loopback relay; the grant still owns authority. */
    ssh?: SshTarget;
    /** A ticket refusal triggers separate account-session validation; it is not itself a logout signal. */
    onTicketRejected?: () => void;
    /** Permanent self-host credential failures must stop retrying and offer pairing again. */
    onPermanentError?: (message: string) => void;
    onLinkEnrolled?: (key: string) => void;
    onHostHello?: () => void;
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
const MAX_PENDING_REQUESTS = 128;
// A backend that never answers is retried on a widening backoff, then given
// up on: after this much consecutive wall-clock failure with no host frame the
// client fails closed to 'stale' (surfaced as an error) instead of reconnecting
// for ever. A successful host frame resets the budget; a manual reconnect (new
// client) starts fresh.
//
// A time budget and not an attempt count, on purpose. An attempt can cost far
// more than its own delay -- a relay that accepts the socket while no host
// answers spends the whole liveness timeout before the next dial -- so a count
// would multiply every such cost, and patience would grow with the very slow
// path it exists to bound.
const RECONNECT_BUDGET_MS = 75_000;
/**
 * The longest this client will ignore a network that has already come back.
 * Nothing here can be told that it returned -- there is no connectivity signal
 * on this platform -- so the ceiling is the whole of what the phone waits
 * through, and the old 30s one was measured doing exactly that: after a ten
 * second outage the app stayed unusable for up to five more seconds with the
 * link already restored, purely waiting out its own timer. A dial is one
 * handshake; waiting is not free.
 *
 * It bounds the widening, and only the widening. A caller that configured a
 * slower base asked for that cadence on purpose -- `scopedMachineClient` asks
 * for 30s inside a 12s deadline, which is a way of asking for one attempt --
 * so the base is kept as a floor below. Shortening it would turn one dial
 * against an unreachable machine into a dial every four seconds.
 */
const RECONNECT_CEILING_MS = 4000;

export class MuxrClient {
    private socket: WebSocket | undefined;
    private dialRelayUrl: string | undefined;
    private readonly pending = new Map<string, Pending>();
    private readonly eventListeners = new Set<EventListener>();
    private readonly stateListeners = new Set<StateListener>();
    private readonly pluginInvalidationListeners = new Set<PluginInvalidationListener>();
    private hosted: DeviceV2Crypto | undefined;
    private seq = 0;
    private closed = false;
    private readonly clientId = nextRequestId('client');
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private reconnectAttempt = 0;
    /** When the current run of failures began; cleared the moment a host frame lands. */
    private reconnectSince: number | undefined;
    /** Valid host traffic observed on the current socket. Request timers use it as a liveness fence. */
    private hostFrameRevision = 0;
    private livenessTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly decodeFailureSockets = new WeakSet<WebSocket>();

    state: ConnectionState = 'closed';

    constructor(private readonly options: MuxrClientOptions) {
        if (options.mode === 'hosted' && options.hostedGrant === undefined) throw new Error('hosted connection requires a verified machine grant');
        this.hosted = options.hostedGrant === undefined ? undefined : new DeviceV2Crypto(options.hostedGrant);
    }

    /** Register this device's Expo push address through the relay HTTP API. */
    async registerPush(token: string, level: LifecycleNotificationLevel): Promise<boolean> {
        if (this.options.token === undefined) return false;
        const response = await fetch(`${relayControlUrl(this.options.relayUrl)}/v1/push/expo-subscribe`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.options.token}`,
            },
            body: JSON.stringify({ token, level }),
        });
        return response.ok;
    }

    get e2eeEnabled(): boolean {
        return this.hosted !== undefined;
    }

    /** Relay accepted us and a host frame arrived on this socket. */
    isLive(): boolean {
        return this.state === 'open'
            && this.socket !== undefined
            && this.socket.readyState === (WebSocket.OPEN ?? 1);
    }

    get activeRelayUrl(): string | undefined {
        return this.isLive() ? this.dialRelayUrl : undefined;
    }

    connect(): void {
        void this.open();
    }

    private async open(): Promise<void> {
        if (this.closed) return;
        if (this.socket !== undefined
            && this.socket.readyState !== (WebSocket.CONNECTING ?? 0)
            && this.socket.readyState !== (WebSocket.OPEN ?? 1)) {
            const stale = this.socket;
            this.socket = undefined;
            stale.onclose = () => {};
            stale.close();
        }
        if (this.socket !== undefined
            && (this.socket.readyState === (WebSocket.CONNECTING ?? 0) || this.socket.readyState === (WebSocket.OPEN ?? 1))) return;
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.setState('connecting');
        const { machineId, token } = this.options;
        let relayUrl = this.options.relayUrl;
        let dialRelayUrl = relayUrl;
        let url: string;
        let failureStage: 'grant' | 'ticket' = 'grant';
        try {
            if (this.options.ssh !== undefined) {
                dialRelayUrl = await sshRelayUrl(relayUrl, machineId, this.options.ssh);
            }
            const legacyToken = this.options.mode === 'local' && token?.startsWith('acctok_') === true;
            const ticketFor = token === undefined || token === '' || legacyToken
                ? undefined
                : (dial: string) => issueWsTicket({ relayUrl: dial, credential: token, machineId, role: 'client', transport: 'relay' });
            // A ticket depends on the credential, never on the grant, so it is
            // requested alongside the grant refresh instead of one round trip
            // after it. A failed refresh still decides the outcome first.
            const earlyDial = dialRelayUrl;
            const earlyTicket = this.options.mode === 'hosted' ? ticketFor?.(earlyDial) : undefined;
            earlyTicket?.catch(() => undefined);
            if (this.options.mode === 'hosted') {
                const latest = await refreshHostedGrant(machineId, token, relayUrl, dialRelayUrl);
                if (latest !== undefined && latest.keyVersion >= (this.hosted?.grant.keyVersion ?? 0)) {
                    if (latest.expiresAt <= Date.now()) throw new Error('hosted device grant expired; pair this browser again');
                    this.hosted = new DeviceV2Crypto(latest);
                    relayUrl = latest.relayUrl;
                    if (this.options.ssh === undefined) dialRelayUrl = relayUrl;
                }
            }
            if (this.options.mode === 'hosted' && (!token || this.hosted === undefined)) throw new Error('hosted connection is missing its credential or grant');
            if (ticketFor === undefined) {
                url = `${dialRelayUrl}?role=client&machineId=${encodeURIComponent(machineId)}${token === undefined || token === '' ? '' : `&token=${encodeURIComponent(token)}`}`;
            } else {
                failureStage = 'ticket';
                const ticket = await (earlyTicket !== undefined && dialRelayUrl === earlyDial ? earlyTicket : ticketFor(dialRelayUrl));
                url = ticketSocketUrl(dialRelayUrl, ticket, 'relay');
            }
        } catch (error) {
            if (this.closed || this.socket !== undefined) return;
            const rejected = error instanceof WsTicketError && (error.status === 401 || error.status === 403);
            const expired = error instanceof Error && /grant expired/i.test(error.message);
            const sshFailure = error instanceof SshConnectionError;
            const sshPermanent = sshFailure && error.permanent;
            const timedOut = error instanceof Error && error.name === 'AbortError';
            recordSocketFailure({
                stage: failureStage,
                code: failureStage === 'ticket'
                    ? error instanceof WsTicketError
                        ? ticketFailureCode(error.status)
                        : timedOut ? 'ticket-timeout' : 'ticket-network'
                    : expired ? 'grant-expired'
                        : error instanceof Error && /missing its credential or grant/i.test(error.message)
                            ? 'grant-missing'
                            : 'grant-refresh-failed',
            });
            const permanent = expired || rejected && this.hosted?.grant.source === 'selfhost' || sshPermanent;
            this.setState(permanent ? 'stale' : 'closed');
            if (rejected) this.options.onTicketRejected?.();
            if (permanent) {
                this.options.onPermanentError?.(sshFailure ? (error as SshConnectionError).message : expired
                    ? 'This browser grant expired. Pair again from `muxr pair --browser`.'
                    : 'This device was revoked. Run `muxr pair` on the machine, then re-pair from Settings → Pair another machine on this device.');
                return;
            }
            // A rejected ticket (401/403) waits the full cap before retrying,
            // but still counts toward the give-up ceiling: a relay that keeps
            // rejecting is unreachable, not something to poll for ever.
            this.scheduleReconnect(error instanceof WsTicketError && (error.status === 401 || error.status === 403) ? 30_000 : undefined);
            return;
        }
        if (this.closed || this.socket !== undefined) return;
        let socket: WebSocket;
        try {
            socket = new WebSocket(url);
        } catch {
            recordSocketFailure({ stage: 'dial', code: 'dial-network' });
            this.setState('closed');
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        this.dialRelayUrl = dialRelayUrl;
        let opened = false;
        let sawHostFrame = false;
        let livenessRecorded = false;
        this.livenessTimer = setTimeout(() => {
            if (this.socket !== socket || socket.readyState !== (WebSocket.CONNECTING ?? 0)) return;
            recordSocketFailure({ stage: 'dial', code: 'dial-timeout' });
            this.retireSocket(socket);
            socket.close();
        }, this.options.requestTimeoutMs ?? 20_000);

        socket.onopen = () => {
            if (this.socket !== socket) {
                socket.close();
                return;
            }
            opened = true;
            clearTimeout(this.livenessTimer);
            // The relay accepts a client peer even when no machine is attached,
            // so socket open is not "connected". Stay `connecting` until the
            // first authenticated host frame arrives (handleMessage flips it);
            // the host answers client.hello immediately when it is alive.
            this.send({ type: 'client.hello', clientId: this.clientId });
            this.livenessTimer = setTimeout(() => {
                if (this.socket !== socket || this.state === 'open' || livenessRecorded) return;
                livenessRecorded = true;
                recordSocketFailure({
                    stage: 'liveness',
                    code: sawHostFrame ? 'all-frames-rejected' : 'no-host-frame',
                });
                this.retireSocket(socket);
                socket.close();
            }, this.options.requestTimeoutMs ?? 20_000);
        };
        socket.onmessage = (message: MessageEvent) => {
            if (this.socket !== socket) return;
            sawHostFrame = true;
            void this.handleMessage(String(message.data), socket);
        };
        socket.onerror = () => {
            if (!opened) recordSocketFailure({ stage: 'dial', code: 'dial-network' });
            socket.close();
        };
        socket.onclose = (event) => {
            if (this.socket === socket && !this.closed && opened) {
                const closeCode = Number.isInteger(event.code) ? event.code : 1006;
                recordSocketFailure({
                    stage: 'close',
                    code: 'socket-closed',
                    closeCode,
                    closeReason: socketCloseReason(closeCode),
                });
            }
            this.retireSocket(socket);
        };
    }

    close(): void {
        this.closed = true;
        clearTimeout(this.livenessTimer);
        this.livenessTimer = undefined;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.rejectPending('client closed');
        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
        void stopSshTunnel();
        this.setState('closed');
    }

    private rejectPending(message: string): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(message));
        }
        this.pending.clear();
    }

    private retireSocket(socket: WebSocket): void {
        if (this.socket !== socket) return;
        clearTimeout(this.livenessTimer);
        this.livenessTimer = undefined;
        this.socket = undefined;
        this.rejectPending('connection lost');
        this.setState('closed');
        this.scheduleReconnect();
    }

    /**
     * Schedule one reconnect on a widening backoff, or fail closed. Past
     * RECONNECT_BUDGET_MS of consecutive failures with no host frame the client
     * stops the internal loop and settles on 'stale' (surfaced as an error) so
     * the UI can show an actionable "can't reach your computer" instead of
     * spinning for ever. The budget is wall-clock, so a slow attempt cannot
     * stretch patience past it. A successful host frame resets the budget and
     * the backoff; a fresh client (sync.reconnect) starts over.
     */
    private scheduleReconnect(floorMs?: number): void {
        if (this.closed) return;
        const now = Date.now();
        if (this.reconnectSince === undefined) this.reconnectSince = now;
        if (now - this.reconnectSince >= RECONNECT_BUDGET_MS) {
            this.setState('stale');
            return;
        }
        const base = this.options.reconnectDelayMs ?? 1500;
        const delay = Math.max(floorMs ?? 0, base, Math.min(base * 2 ** this.reconnectAttempt++, RECONNECT_CEILING_MS));
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
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
            const socket = this.socket;
            if (!this.isLive() || socket === undefined) {
                reject(new Error('not connected'));
                return;
            }
            if (this.pending.size >= MAX_PENDING_REQUESTS) {
                reject(new Error('too many pending requests'));
                return;
            }
            const requestId = nextRequestId('rn');
            const hostFrameRevision = this.hostFrameRevision;
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                // A timed-out request proves staleness only when no authenticated
                // host traffic arrived after it began. Replace that half-open route.
                if (this.socket === socket && this.hostFrameRevision === hostFrameRevision && this.state !== 'closed') {
                    this.setState('stale');
                    this.retireSocket(socket);
                    socket.close();
                }
                reject(new Error(
                    `request timed out: ${type} (connection reset; try again after muxr reconnects)`,
                ));
            }, timeoutMs ?? this.options.requestTimeoutMs ?? 20000);

            this.pending.set(requestId, {
                resolve: (value) => resolve(value as RequestResult<T>),
                // Frozen hosted routing label; see ROUTING_CHANNELS in the contract.
                channel: routingChannelForRequest(type),
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
        const channel = routingChannelForRequest(frame.type);
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
            payload: sealed?.payload ?? encodePayload(frame),
        };
        this.socket?.send(JSON.stringify(envelope));
    }

    private recordDecodeFailure(socket: WebSocket, code: Extract<ConnectionDiagnosticSocketFailureCode, 'machine-mismatch' | 'context-mismatch' | 'open-failed'>): void {
        if (this.decodeFailureSockets.has(socket)) return;
        this.decodeFailureSockets.add(socket);
        recordSocketFailure({ stage: 'decode', code });
    }

    private async handleMessage(raw: string, socket: WebSocket): Promise<void> {
        let envelope: Envelope;
        try {
            envelope = JSON.parse(raw) as Envelope;
        } catch {
            this.recordDecodeFailure(socket, 'open-failed');
            return;
        }
        if (envelope.header.machineId !== this.options.machineId) {
            this.recordDecodeFailure(socket, 'machine-mismatch');
            return;
        }
        const streamId = envelope.header.streamId ?? envelope.header.sessionId ?? 'machine';
        if (this.hosted !== undefined) {
            const channel = envelope.header.channel;
            if (envelope.header.senderId !== this.options.machineId || envelope.header.recipientId !== '*'
                || (channel !== 'session' && channel !== 'attachment') || envelope.header.streamId !== streamId
                || envelope.header.keyVersion !== this.hosted.grant.keyVersion) {
                this.recordDecodeFailure(socket, 'context-mismatch');
                return;
            }
        }
        let frame: HostFrame;
        try {
            const plaintext = this.hosted === undefined
                ? envelope.payload
                : this.hosted.open(envelope.header.channel as 'session' | 'attachment', streamId, envelope.payload, envelope.header.seq);
            frame = decodePayload<HostFrame>(await plaintext);
        } catch {
            this.recordDecodeFailure(socket, 'open-failed');
            return;
        }

        if (this.socket !== socket) return;

        // Socket open only proves the relay accepted us; the first frame that
        // survives the machine's E2EE context proves the host is really there.
        this.hostFrameRevision += 1;
        this.reconnectAttempt = 0;
        this.reconnectSince = undefined;
        clearTimeout(this.livenessTimer);
        this.livenessTimer = undefined;
        if (this.state !== 'open') this.setState('open');

        if (frame.type === 'result') {
            const pending = this.pending.get(frame.requestId);
            if (pending === undefined) return;
            if (this.hosted !== undefined && envelope.header.channel !== pending.channel) return;
            clearTimeout(pending.timer);
            this.pending.delete(frame.requestId);
            if (frame.ok) {
                if (pending.requestType === 'herdr.tree' && frame.data !== null && typeof frame.data === 'object'
                    && 'linkEnrolledKey' in frame.data && typeof frame.data.linkEnrolledKey === 'string') {
                    this.options.onLinkEnrolled?.(frame.data.linkEnrolledKey);
                }
                pending.resolve(frame.data);
            } else pending.reject(requestFailure(pending.requestType, frame.error, frame.code));
            return;
        }

        if (this.hosted !== undefined && envelope.header.channel !== 'session') return;
        if (frame.type === 'machine.hello') this.options.onHostHello?.();
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
