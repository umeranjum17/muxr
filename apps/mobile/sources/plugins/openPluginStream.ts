import {
    decodePayload,
    encodePayload,
    issueWsTicket,
    newRealtimeChannel,
    nextRequestId,
    parseRealtimeClientFrame,
    parseRealtimeHostFrame,
    realtimeSocketUrl,
    ticketSocketUrl,
    type ClientFrame,
    type ClientRequest,
    type Envelope,
    type HostFrame,
    type PluginStreamCapability,
    type RealtimeClientFrame,
    type RealtimeHostFrame,
} from '@muxr/contract';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import {
    DeviceV2Crypto,
    getCachedHostedGrant,
    refreshHostedGrant,
    type StoredHostedGrant,
} from '@/state/hostedE2ee';
import { pluginSnapshot, refreshPlugins } from './pluginStore';

export interface PluginStream {
    onFrame: (listener: (frame: RealtimeHostFrame) => void) => () => void;
    onClose: (listener: (reason?: string) => void) => () => void;
    send: (frame: RealtimeClientFrame) => void;
    close: (reason?: string) => void;
}

/** Everything reconnect may use, captured once before the call opens. */
export interface PluginStreamSnapshot {
    capability: string;
    machineId: string;
    relayUrl: string;
    mode: 'hosted' | 'local';
    token: string;
    pluginId: string;
    manifestHash: string;
    contributionId: string;
    grant?: StoredHostedGrant;
}

export async function capturePluginStreamSnapshot(capability: string, machineId: string): Promise<PluginStreamSnapshot> {
    const settings = { ...getCachedConnectionSettings() };
    if (settings.machineId !== machineId) throw new Error('End voice before switching computers.');
    const cachedGrant = settings.mode === 'hosted' ? getCachedHostedGrant(machineId) : undefined;
    if (settings.mode === 'hosted' && cachedGrant === undefined) throw new Error('stream: hosted machine grant is missing');
    const latestGrant = cachedGrant === undefined
        ? undefined
        : await refreshHostedGrant(machineId, cachedGrant.credential, cachedGrant.relayUrl) ?? cachedGrant;
    if (getCachedConnectionSettings().machineId !== machineId) throw new Error('End voice before switching computers.');
    const grant = latestGrant === undefined ? undefined : JSON.parse(JSON.stringify(latestGrant)) as StoredHostedGrant;
    if (grant !== undefined && grant.expiresAt <= Date.now()) throw new Error('stream: device grant expired; pair again');

    await refreshPlugins();
    if (getCachedConnectionSettings().machineId !== machineId) throw new Error('End voice before switching computers.');
    const matches = pluginSnapshot().filter(({ summary }) => summary.capabilities[capability] !== undefined);
    if (matches.length === 0) throw new Error(`${capability} plugin is unavailable or not approved`);
    if (matches.length > 1) throw new Error(`${capability} is claimed by multiple enabled plugins; disable all but one`);
    const { summary, manifest } = matches[0]!;
    const contributionId = summary.capabilities[capability]!;
    const contribution = manifest.contributions.find((candidate): candidate is PluginStreamCapability =>
        candidate.slot === 'host.stream' && candidate.id === contributionId);
    if (contribution === undefined) throw new Error(`${capability} capability is not a host.stream contribution`);
    return {
        capability,
        machineId,
        relayUrl: grant?.relayUrl ?? settings.relayUrl,
        mode: settings.mode,
        token: grant?.credential ?? settings.token,
        pluginId: summary.pluginId,
        manifestHash: summary.manifestHash,
        contributionId,
        ...(grant === undefined ? {} : { grant }),
    };
}

/** One pinned control request; it never consults or refreshes global machine state. */
async function requestPinnedStream(snapshot: PluginStreamSnapshot, channel: string, sessionId?: string): Promise<void> {
    const hosted = snapshot.grant === undefined ? undefined : new DeviceV2Crypto(snapshot.grant);
    const legacyToken = snapshot.mode === 'local' && snapshot.token.startsWith('acctok_');
    const url = snapshot.token === '' || legacyToken
        ? `${snapshot.relayUrl}?role=client&machineId=${encodeURIComponent(snapshot.machineId)}${snapshot.token === '' ? '' : `&token=${encodeURIComponent(snapshot.token)}`}`
        : ticketSocketUrl(snapshot.relayUrl, await issueWsTicket({
            relayUrl: snapshot.relayUrl,
            credential: snapshot.token,
            machineId: snapshot.machineId,
            role: 'client',
            transport: 'relay',
        }), 'relay');
    const requestId = nextRequestId('voice');
    await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        let seq = 0;
        let done = false;
        const finish = (error?: Error): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            if (error === undefined) resolve(); else reject(error);
        };
        const send = (frame: ClientFrame, streamId = 'machine'): void => {
            seq += 1;
            const sealed = hosted?.seal('session', streamId, encodePayload(frame));
            socket.send(JSON.stringify({
                header: {
                    machineId: snapshot.machineId,
                    ...(streamId === 'machine' ? {} : { sessionId: streamId }),
                    ...(sealed === undefined ? {} : {
                        senderId: hosted!.grant.deviceId,
                        recipientId: snapshot.machineId,
                        channel: 'session' as const,
                        streamId,
                        keyVersion: hosted!.grant.keyVersion,
                    }),
                    seq: sealed?.sequence ?? seq,
                    at: Date.now(),
                },
                payload: sealed?.payload ?? encodePayload(frame),
            } satisfies Envelope));
        };
        const timer = setTimeout(() => finish(new Error('stream control request timed out')), 20_000);
        socket.onopen = () => {
            send({ type: 'client.hello', clientId: nextRequestId('voice-client') });
            send({
                type: 'plugin.stream',
                requestId,
                params: {
                    pluginId: snapshot.pluginId,
                    manifestHash: snapshot.manifestHash,
                    contributionId: snapshot.contributionId,
                    channel,
                    ...(sessionId === undefined ? {} : { sessionId }),
                },
            } as ClientRequest, sessionId);
        };
        socket.onerror = () => finish(new Error('stream control connection failed'));
        socket.onclose = () => finish(new Error('stream control connection closed'));
        socket.onmessage = (event) => {
            void (async () => {
                try {
                    const envelope = JSON.parse(String(event.data)) as Envelope;
                    if (envelope.header.machineId !== snapshot.machineId) return;
                    const streamId = envelope.header.streamId ?? envelope.header.sessionId ?? 'machine';
                    const plaintext = hosted === undefined ? envelope.payload : (() => {
                        if (envelope.header.senderId !== snapshot.machineId || envelope.header.recipientId !== '*'
                            || envelope.header.channel !== 'session' || envelope.header.streamId !== streamId
                            || envelope.header.keyVersion !== hosted.grant.keyVersion) throw new Error('stream: invalid hosted control context');
                        return hosted.open('session', streamId, envelope.payload, envelope.header.seq);
                    })();
                    const frame = decodePayload<HostFrame>(await plaintext);
                    if (frame.type !== 'result' || frame.requestId !== requestId) return;
                    if (frame.ok) finish();
                    else finish(new Error(frame.error));
                } catch { finish(new Error('stream control frame rejected')); }
            })();
        };
    });
}

/** Resolve a semantic stream capability without ever naming a provider/plugin id. */
export async function openPluginStream(
    capability: string,
    options: { sessionId?: string; machineId?: string; snapshot?: PluginStreamSnapshot } = {},
): Promise<PluginStream> {
    const snapshot = options.snapshot ?? await capturePluginStreamSnapshot(
        capability,
        options.machineId ?? getCachedConnectionSettings().machineId,
    );
    if (snapshot.capability !== capability) throw new Error('stream capability snapshot mismatch');
    const grant = snapshot.grant;
    const hosted = grant === undefined ? undefined : new DeviceV2Crypto(grant);
    const channel = newRealtimeChannel();
    await requestPinnedStream(snapshot, channel, options.sessionId);

    const relayUrl = snapshot.relayUrl;
    const url = grant !== undefined
        ? ticketSocketUrl(relayUrl, await issueWsTicket({
            relayUrl,
            credential: grant.credential,
            machineId: snapshot.machineId,
            role: 'client',
            transport: 'stream',
            channel,
        }), 'stream')
        : snapshot.token === '' || snapshot.token.startsWith('acctok_')
          ? realtimeSocketUrl(relayUrl, {
              machineId: snapshot.machineId,
              channel,
              role: 'client',
              ...(snapshot.token === '' ? {} : { token: snapshot.token }),
          })
          : ticketSocketUrl(relayUrl, await issueWsTicket({
              relayUrl,
              credential: snapshot.token,
              machineId: snapshot.machineId,
              role: 'client',
              transport: 'stream',
              channel,
          }), 'stream');

    const frameListeners = new Set<(frame: RealtimeHostFrame) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    let closed = false;
    let socket: WebSocket | undefined;
    let opened = false;
    let transportEnded = false;
    let pendingMessages = 0;

    const close = (reason?: string): void => {
        if (closed) return;
        closed = true;
        const current = socket;
        socket = undefined;
        if (current !== undefined) {
            current.onopen = null;
            current.onmessage = null;
            current.onerror = null;
            current.onclose = null;
            current.close();
        }
        for (const listener of closeListeners) listener(reason);
    };
    const closeEndedTransport = (): void => {
        if (transportEnded && pendingMessages === 0 && !closed) close('stream disconnected');
    };

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            close('stream connection timed out');
            reject(new Error('stream connection timed out'));
        }, 15_000);
        const next = new WebSocket(url);
        socket = next;
        next.onopen = () => {
            clearTimeout(timer);
            if (closed || socket !== next) return;
            opened = true;
            resolve();
        };
        next.onerror = () => {
            clearTimeout(timer);
            if (!opened) {
                close('stream connection failed');
                reject(new Error('stream connection failed'));
            } else {
                transportEnded = true;
                closeEndedTransport();
            }
        };
        next.onclose = () => {
            clearTimeout(timer);
            if (socket !== next || closed) return;
            transportEnded = true;
            closeEndedTransport();
        };
        next.onmessage = (event) => {
            if (closed || socket !== next) return;
            pendingMessages += 1;
            void (async () => {
                try {
                    let text = String(event.data);
                    if (hosted !== undefined) {
                        const envelope = JSON.parse(text) as Envelope;
                        if (envelope.header.machineId !== snapshot.machineId
                            || envelope.header.senderId !== snapshot.machineId
                            || envelope.header.recipientId !== '*'
                            || envelope.header.channel !== 'stream'
                            || envelope.header.streamId !== channel
                            || envelope.header.keyVersion !== grant?.keyVersion) {
                            throw new Error('stream: invalid hosted routing context');
                        }
                        text = await hosted.open('stream', channel, envelope.payload, envelope.header.seq);
                    }
                    const frame = parseRealtimeHostFrame(JSON.parse(text));
                    if (frame.type === 'realtime.closed') close(frame.reason);
                    else for (const listener of frameListeners) listener(frame);
                } catch {
                    close('stream frame rejected');
                } finally {
                    pendingMessages -= 1;
                    closeEndedTransport();
                }
            })();
        };
    });

    return {
        onFrame: (listener) => {
            frameListeners.add(listener);
            return () => frameListeners.delete(listener);
        },
        onClose: (listener) => {
            closeListeners.add(listener);
            return () => closeListeners.delete(listener);
        },
        send: (frame) => {
            if (closed || socket === undefined || socket.readyState !== WebSocket.OPEN) return;
            if (frame.type === 'realtime.audio' && socket.bufferedAmount > 512 * 1024) return;
            const clean = parseRealtimeClientFrame(frame);
            const plaintext = JSON.stringify(clean);
            const sealed = hosted?.seal('stream', channel, plaintext);
            socket.send(sealed === undefined ? plaintext : JSON.stringify({
                header: {
                    machineId: snapshot.machineId,
                    senderId: grant!.deviceId,
                    recipientId: snapshot.machineId,
                    channel: 'stream',
                    streamId: channel,
                    keyVersion: grant!.keyVersion,
                    seq: sealed.sequence,
                    at: Date.now(),
                },
                payload: sealed.payload,
            } satisfies Envelope));
        },
        close: () => close(),
    };
}
