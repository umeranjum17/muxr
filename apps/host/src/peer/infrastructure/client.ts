import WebSocket from 'ws';
import { DeviceLink, LinkError, hostId, type DeviceGrant as LinkGrant, type LinkStatus } from '@byokit/link';
import { nextRequestId, type HostFrame, type RequestParams, type RequestResult } from '@muxr/contract';
import { verifyDeviceGrant, type KeyPair, type SealedDeviceGrant } from '@muxr/crypto';

export type PeerClientRequestType = 'machines.list' | 'session.list' | 'herdr.tree' | 'herdr.agentKinds'
    | 'pane.read' | 'session.status' | 'agent.watch' | 'session.prompt' | 'session.start';

export interface PeerClientTransport {
    connect(): Promise<void>;
    request<T extends PeerClientRequestType>(type: T, params: RequestParams<T>, signal?: AbortSignal): Promise<RequestResult<T>>;
    close(): void;
}

export type PeerConnectionPhase = 'link-connect' | 'liveness-proof';
export interface PeerConnectionDiagnostic {
    phase: PeerConnectionPhase;
    outcome: 'ok' | 'timeout' | 'unavailable';
    durationMs: number;
    code?: string;
}

export interface NodePeerClientOptions {
    relayUrl: string;
    machineId: string;
    peerDeviceId: string;
    peerKey: KeyPair;
    pinnedMachineSigningPublicKey: string;
    sealedGrant: SealedDeviceGrant;
    requestTimeoutMs?: number;
    onConnectionDiagnostic?: (event: PeerConnectionDiagnostic) => void;
}

const aborted = (): Error => Object.assign(new Error('peer request cancelled'), { name: 'AbortError' });

/** Headless peer device on the same authenticated link as a phone. */
export class NodePeerClient implements PeerClientTransport {
    private readonly link: DeviceLink;
    private readonly waiters = new Set<() => void>();
    private connecting: Promise<void> | undefined;
    private online = false;
    private closed = false;

    constructor(private readonly options: NodePeerClientOptions) {
        const grant = verifyDeviceGrant(options.sealedGrant, {
            pinnedMachineSigningPublicKey: options.pinnedMachineSigningPublicKey,
            deviceKey: options.peerKey,
            deviceId: options.peerDeviceId,
        });
        if (grant.deviceKind !== 'peer') throw new Error('peer grant has the wrong device kind');
        if (grant.machineId !== options.machineId) throw new Error('peer grant has the wrong target machine');
        const hostKey = Buffer.from(options.sealedGrant.sender, 'base64');
        const relay = new URL(options.relayUrl.replace(/^ws/i, 'http'));
        const scheme = relay.protocol === 'https:' ? 'wss' : 'ws';
        const linkGrant: LinkGrant = {
            v: 1,
            secretKey: Buffer.from(options.peerKey.secretKey, 'base64').toString('base64url'),
            host: hostKey.toString('base64url'),
            hostName: options.machineId,
            urls: [`${scheme}://${relay.host}/link/v1/${hostId(hostKey)}`],
            device: { id: options.peerDeviceId, name: 'Peer computer', role: 'control' },
        };
        this.link = new DeviceLink(linkGrant, {
            WebSocket: WebSocket as never,
            onStatus: (status: LinkStatus) => {
                if (status !== 'online') this.online = false;
                for (const notify of this.waiters) notify();
            },
        });
    }

    connect(): Promise<void> {
        if (this.closed) return Promise.reject(aborted());
        if (this.online && this.link.status === 'online') return Promise.resolve();
        if (this.link.status === 'refused') this.link.retry();
        this.connecting ??= this.connectOnce().finally(() => { this.connecting = undefined; });
        return this.connecting;
    }

    private async connectOnce(): Promise<void> {
        const timeoutMs = this.options.requestTimeoutMs ?? 20_000;
        const started = Date.now();
        try {
            await this.waitForOnline(timeoutMs);
            this.report('link-connect', 'ok', started);
        } catch (error) {
            this.report('link-connect', error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'unavailable', started);
            throw error;
        }
        const livenessAt = Date.now();
        try {
            const requestId = nextRequestId('peer');
            const answer = await this.link.request('machines.list', { type: 'machines.list', requestId, params: {} }, { timeoutMs }) as HostFrame;
            if (answer.type !== 'result' || answer.requestId !== requestId || answer.ok !== true) throw new Error('peer target did not prove it was live');
            if (this.closed) throw aborted();
            this.online = true;
            this.report('liveness-proof', 'ok', livenessAt);
        } catch (error) {
            this.report('liveness-proof', error instanceof LinkError && error.code === 'timeout' ? 'timeout' : 'unavailable', livenessAt,
                error instanceof LinkError && error.code === 'timeout' ? 'liveness-timeout' : undefined);
            throw error;
        }
    }

    private waitForOnline(ms: number): Promise<void> {
        if (this.link.status === 'online') return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => finish(new Error('peer link timed out')), ms);
            const check = (): void => {
                if (this.closed) finish(aborted());
                else if (this.link.status === 'online') finish();
                else if (this.link.status === 'removed' || this.link.status === 'refused') finish(new Error(`peer link ${this.link.status}`));
            };
            const finish = (error?: Error): void => {
                clearTimeout(timeout);
                this.waiters.delete(check);
                if (error) reject(error); else resolve();
            };
            this.waiters.add(check);
            check();
        });
    }

    async request<T extends PeerClientRequestType>(type: T, params: RequestParams<T>, signal?: AbortSignal): Promise<RequestResult<T>> {
        const mutation = typeof params === 'object' && params !== null && 'peerMutation' in params
            ? (params as { peerMutation?: { notValidAfter: number } }).peerMutation : undefined;
        let delay = 100;
        for (;;) {
            if (signal?.aborted || this.closed) throw aborted();
            try {
                await this.connect();
                if (signal?.aborted || this.closed) throw aborted();
                const requestId = nextRequestId('peer');
                const timeoutMs = peerClientTimeoutMs(type, params, this.options.requestTimeoutMs ?? 20_000);
                let onAbort: (() => void) | undefined;
                const cancelled = new Promise<never>((_, reject) => { onAbort = () => reject(aborted()); signal?.addEventListener('abort', onAbort, { once: true }); });
                let answer: HostFrame;
                try {
                    answer = await Promise.race([
                        this.link.request(type, { type, requestId, params }, { timeoutMs,
                            ...(mutation === undefined ? {} : { notValidAfter: mutation.notValidAfter }) }),
                        ...(signal === undefined ? [] : [cancelled]),
                    ]) as HostFrame;
                } finally { if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort); }
                if (answer.type !== 'result' || answer.requestId !== requestId) throw new Error('peer returned a malformed response');
                if (!answer.ok) throw Object.assign(new Error(answer.error ?? 'peer request failed'), { code: answer.code, fromHost: true });
                return answer.data as RequestResult<T>;
            } catch (error) {
                if (signal?.aborted || this.closed || (error as { name?: unknown }).name === 'AbortError') throw error;
                const fromHost = (error as { fromHost?: unknown }).fromHost === true;
                const uncertain = (error as { code?: unknown }).code === 'peer-operation-uncertain';
                if (mutation === undefined || fromHost && !uncertain || error instanceof LinkError && (error.code === 'removed' || error.code === 'not-paired')) throw error;
                if (Date.now() >= mutation.notValidAfter) {
                    throw Object.assign(new Error('peer mutation outcome is unresolved after its validity window; do not retry with a new operation id'), { code: 'peer-mutation-unresolved' });
                }
                await new Promise<void>((resolve, reject) => {
                    const finish = (error?: Error): void => {
                        clearTimeout(timer);
                        signal?.removeEventListener('abort', onAbort);
                        if (error) reject(error); else resolve();
                    };
                    const onAbort = () => finish(aborted());
                    const timer = setTimeout(() => finish(), Math.min(delay, mutation.notValidAfter - Date.now()));
                    signal?.addEventListener('abort', onAbort, { once: true });
                });
                delay = Math.min(delay * 2, 2_000);
            }
        }
    }

    close(): void {
        this.closed = true;
        this.online = false;
        this.link.stop();
        for (const notify of this.waiters) notify();
    }

    private report(phase: PeerConnectionPhase, outcome: PeerConnectionDiagnostic['outcome'], at: number, code?: string): void {
        this.options.onConnectionDiagnostic?.({ phase, outcome, durationMs: Date.now() - at,
            ...(code === undefined ? {} : { code }) });
    }
}

function peerClientTimeoutMs(type: PeerClientRequestType, params: unknown, defaultMs: number): number {
    if (type !== 'agent.watch') return defaultMs;
    const timeoutMs = (params as RequestParams<'agent.watch'>).timeoutMs;
    return Math.min(Math.max(Math.trunc(timeoutMs ?? 30 * 60_000), 1_000), 60 * 60_000) + 20_000;
}
