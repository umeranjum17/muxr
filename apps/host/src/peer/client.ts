import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import {
    decodePayload,
    encodePayload,
    issueWsTicket,
    nextRequestId,
    relayControlUrl,
    ticketSocketUrl,
    type ClientFrame,
    type ClientRequest,
    type Envelope,
    type HostFrame,
    type RequestParams,
    type RequestResult,
    type RequestType,
} from '@muxr/contract';
import {
    deriveV2Key,
    newV2ReplayTracker,
    newV2SenderState,
    openV2,
    sealV2,
    v2EnvelopeSequence,
    verifyDeviceGrant,
    type DeviceGrant,
    type KeyPair,
    type SealedDeviceGrant,
    type V2ReplayTracker,
    type V2SenderState,
} from '@muxr/crypto';

export type PeerClientRequestType = 'machines.list' | 'session.list' | 'herdr.tree' | 'herdr.agentKinds'
    | 'pane.read' | 'session.status' | 'agent.watch' | 'session.prompt' | 'session.start';

export interface PeerClientTransport {
    connect(): Promise<void>;
    request<T extends PeerClientRequestType>(type: T, params: RequestParams<T>, signal?: AbortSignal): Promise<RequestResult<T>>;
    close(): void;
}

export interface NodePeerClientOptions {
    relayUrl: string;
    machineId: string;
    credential: string;
    peerDeviceId: string;
    peerKey: KeyPair;
    pinnedMachineSigningPublicKey: string;
    sealedGrant: SealedDeviceGrant;
    grantPath?: string;
    requestTimeoutMs?: number;
    fetch?: typeof fetch;
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    removeAbort?: () => void;
}

/** Headless role=client transport. It never exposes arbitrary request types. */
export class NodePeerClient implements PeerClientTransport {
    private socket: WebSocket | undefined;
    private grant: DeviceGrant;
    private readonly pending = new Map<string, Pending>();
    private readonly senders = new Map<string, V2SenderState>();
    private readonly replays = new Map<string, V2ReplayTracker>();
    private authenticated = false;
    private connectPromise: Promise<void> | undefined;
    private resolveConnect: (() => void) | undefined;
    private rejectConnect: ((error: Error) => void) | undefined;
    private connectTimer?: ReturnType<typeof setTimeout>;
    private livenessRequestId: string | undefined;

    constructor(private readonly options: NodePeerClientOptions) {
        this.grant = this.verify(options.sealedGrant);
    }

    async connect(): Promise<void> {
        if (this.authenticated) return;
        if (this.connectPromise !== undefined) return this.connectPromise;
        const connecting = new Promise<void>((resolve, reject) => {
            this.resolveConnect = resolve;
            this.rejectConnect = reject;
        });
        this.connectPromise = connecting;
        try {
            await this.refreshGrant();
            const ticket = await issueWsTicket({
                relayUrl: this.options.relayUrl,
                credential: this.options.credential,
                machineId: this.options.machineId,
                role: 'client',
                transport: 'relay',
            });
            const socket = new WebSocket(ticketSocketUrl(this.options.relayUrl, ticket, 'relay'));
            this.socket = socket;
            this.connectTimer = setTimeout(() => this.fail(new Error('peer target did not prove it was live')), this.options.requestTimeoutMs ?? 20_000);
            socket.on('open', () => {
                this.livenessRequestId = `peer-live_${randomBytes(24).toString('base64url')}`;
                this.send({ type: 'client.hello', clientId: nextRequestId('peer') });
                this.send({ type: 'machines.list', requestId: this.livenessRequestId, params: {} });
            });
            socket.on('message', (raw) => this.onMessage(String(raw)));
            socket.on('error', () => socket.close());
            socket.on('close', () => {
                if (this.socket !== socket) return;
                this.socket = undefined;
                this.fail(new Error('peer connection closed'));
            });
        } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
        return connecting;
    }

    async request<T extends PeerClientRequestType>(type: T, params: RequestParams<T>, signal?: AbortSignal): Promise<RequestResult<T>> {
        const mutation = typeof params === 'object' && params !== null && 'peerMutation' in params
            ? (params as { peerMutation?: { notValidAfter: number } }).peerMutation : undefined;
        let retryMs = 100;
        for (;;) {
            if (signal?.aborted) throw Object.assign(new Error('peer request cancelled'), { name: 'AbortError' });
            try { return await this.requestOnce(type, params, signal); }
            catch (error) {
                if (signal?.aborted || (error as { name?: unknown }).name === 'AbortError') throw error;
                const fromHost = (error as { fromHost?: unknown }).fromHost === true;
                const uncertain = (error as { code?: unknown }).code === 'peer-operation-uncertain';
                if (mutation === undefined || fromHost && !uncertain || Date.now() >= mutation.notValidAfter) {
                    if (mutation !== undefined && (!fromHost || uncertain) && Date.now() >= mutation.notValidAfter) {
                        throw Object.assign(new Error('peer mutation outcome is unresolved after its validity window; do not retry with a new operation id'), { code: 'peer-mutation-unresolved' });
                    }
                    throw error;
                }
                await this.wait(Math.min(retryMs, Math.max(1, mutation.notValidAfter - Date.now())), signal);
                retryMs = Math.min(retryMs * 2, 2_000);
            }
        }
    }

    private async requestOnce<T extends PeerClientRequestType>(type: T, params: RequestParams<T>, signal?: AbortSignal): Promise<RequestResult<T>> {
        await this.connect();
        if (signal?.aborted) throw Object.assign(new Error('peer request cancelled'), { name: 'AbortError', dispatched: false });
        if (!this.authenticated || this.socket?.readyState !== WebSocket.OPEN) throw new Error('peer is not connected');
        return new Promise<RequestResult<T>>((resolve, reject) => {
            const requestId = nextRequestId('peer');
            let dispatched = false;
            const timeoutMs = type === 'agent.watch'
                ? Math.min(Math.max(Math.trunc((params as RequestParams<'agent.watch'>).timeoutMs ?? 30 * 60_000), 1_000), 60 * 60_000) + 20_000
                : this.options.requestTimeoutMs ?? 20_000;
            const finish = (error?: Error, value?: unknown): void => {
                const pending = this.pending.get(requestId);
                if (pending === undefined) return;
                clearTimeout(pending.timer);
                pending.removeAbort?.();
                this.pending.delete(requestId);
                if (error !== undefined) reject(error);
                else resolve(value as RequestResult<T>);
            };
            const timer = setTimeout(() => finish(Object.assign(new Error(`peer request timed out: ${type}`), { dispatched })), timeoutMs);
            const onAbort = (): void => finish(Object.assign(new Error('peer request cancelled'), { name: 'AbortError', dispatched }));
            signal?.addEventListener('abort', onAbort, { once: true });
            this.pending.set(requestId, {
                resolve: (value) => finish(undefined, value),
                reject: (error) => finish(Object.assign(error, { dispatched })),
                timer,
                ...(signal === undefined ? {} : { removeAbort: () => signal.removeEventListener('abort', onAbort) }),
            });
            const sessionId = typeof params === 'object' && params !== null && 'sessionId' in params
                ? String((params as { sessionId: unknown }).sessionId) : undefined;
            dispatched = this.send({ type, requestId, params } as ClientRequest, sessionId);
        });
    }

    close(): void {
        const socket = this.socket;
        this.socket = undefined;
        this.fail(new Error('peer client closed'));
        socket?.close();
    }

    private verify(grant: SealedDeviceGrant): DeviceGrant {
        const opened = verifyDeviceGrant(grant, {
            pinnedMachineSigningPublicKey: this.options.pinnedMachineSigningPublicKey,
            deviceKey: this.options.peerKey,
            deviceId: this.options.peerDeviceId,
        });
        if (opened.deviceKind !== 'peer') throw new Error('peer grant has the wrong device kind');
        return opened;
    }

    private async refreshGrant(): Promise<void> {
        const response = await (this.options.fetch ?? fetch)(relayControlUrl(
            this.options.relayUrl,
            this.options.grantPath ?? `/v1/machines/${encodeURIComponent(this.options.machineId)}/grant`,
        ), {
            headers: { authorization: `Bearer ${this.options.credential}` },
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`peer grant refresh failed (${response.status})`);
        const body = await response.json() as { grant?: unknown };
        if (typeof body.grant !== 'string') throw new Error('peer grant refresh returned invalid data');
        let sealed: SealedDeviceGrant;
        try { sealed = JSON.parse(body.grant) as SealedDeviceGrant; }
        catch { throw new Error('peer grant refresh returned malformed data'); }
        const refreshed = this.verify(sealed);
        if (refreshed.keyVersion < this.grant.keyVersion) throw new Error('peer grant refresh attempted a key rollback');
        const changed = refreshed.keyVersion !== this.grant.keyVersion
            || refreshed.dataKey !== this.grant.dataKey || refreshed.ingressKey !== this.grant.ingressKey;
        this.grant = refreshed;
        if (changed) {
            this.senders.clear();
            this.replays.clear();
        }
    }

    private send(frame: ClientFrame, sessionId?: string): boolean {
        if (this.socket?.readyState !== WebSocket.OPEN) return false;
        const channel = 'session';
        const streamId = sessionId ?? 'machine';
        const state = this.senders.get(channel) ?? newV2SenderState();
        this.senders.set(channel, state);
        const payload = sealV2(encodePayload(frame), deriveV2Key(this.grant.ingressKey, 'client->host'), {
            machineId: this.grant.machineId,
            senderId: this.grant.deviceId,
            recipientId: this.grant.machineId,
            channel,
            streamId,
            keyVersion: this.grant.keyVersion,
        }, state);
        const envelope: Envelope = {
            header: {
                machineId: this.grant.machineId,
                ...(sessionId === undefined ? {} : { sessionId }),
                senderId: this.grant.deviceId,
                recipientId: this.grant.machineId,
                channel,
                streamId,
                keyVersion: this.grant.keyVersion,
                seq: v2EnvelopeSequence(payload),
                at: Date.now(),
            },
            payload,
        };
        this.socket.send(JSON.stringify(envelope));
        return true;
    }

    private onMessage(raw: string): void {
        try {
            const envelope = JSON.parse(raw) as Envelope;
            if (envelope.header.machineId !== this.grant.machineId || envelope.header.senderId !== this.grant.machineId
                || envelope.header.recipientId !== this.grant.deviceId || envelope.header.channel !== 'session'
                || envelope.header.keyVersion !== this.grant.keyVersion || envelope.header.streamId === undefined
                || envelope.header.seq !== v2EnvelopeSequence(envelope.payload)) throw new Error('peer response routing mismatch');
            const replayKey = envelope.header.streamId;
            const replay = this.replays.get(replayKey) ?? newV2ReplayTracker();
            this.replays.set(replayKey, replay);
            const plaintext = openV2(envelope.payload, deriveV2Key(this.grant.dataKey, 'host->client'), {
                machineId: this.grant.machineId,
                senderId: this.grant.machineId,
                recipientId: this.grant.deviceId,
                channel: 'session',
                streamId: envelope.header.streamId,
                keyVersion: this.grant.keyVersion,
            }, replay);
            const decoded = decodePayload<HostFrame>(plaintext) as unknown;
            if (typeof decoded !== 'object' || decoded === null) return;
            const frame = decoded as HostFrame;
            if (!this.authenticated) {
                if (frame.type !== 'result' || frame.requestId !== this.livenessRequestId || frame.ok !== true) return;
                this.authenticated = true;
                this.livenessRequestId = undefined;
                if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
                this.resolveConnect?.();
            }
            if (frame.type !== 'result' || typeof frame.requestId !== 'string' || typeof frame.ok !== 'boolean') return;
            const pending = this.pending.get(frame.requestId);
            if (pending === undefined) return;
            if (frame.ok) pending.resolve(frame.data);
            else if (typeof frame.error === 'string') pending.reject(Object.assign(new Error(frame.error), { code: frame.code, fromHost: true }));
            else pending.reject(Object.assign(new Error('peer returned a malformed error response'), { fromHost: true }));
        } catch {
            // Undecryptable or misrouted peer data is ignored; the request timer remains authoritative.
        }
    }

    private wait(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(done, ms);
            const onAbort = (): void => done(Object.assign(new Error('peer request cancelled'), { name: 'AbortError' }));
            function done(error?: Error): void {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                if (error === undefined) resolve(); else reject(error);
            }
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    private fail(error: Error): void {
        if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
        if (!this.authenticated) this.rejectConnect?.(error);
        this.connectPromise = undefined;
        this.livenessRequestId = undefined;
        this.resolveConnect = undefined;
        this.rejectConnect = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.authenticated = false;
    }
}
