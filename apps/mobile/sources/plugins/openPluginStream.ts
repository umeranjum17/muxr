import {
    issueWsTicket,
    newRealtimeChannel,
    parseRealtimeClientFrame,
    parseRealtimeHostFrame,
    realtimeSocketUrl,
    ticketSocketUrl,
    type Envelope,
    type PluginStreamCapability,
    type RealtimeClientFrame,
    type RealtimeHostFrame,
} from '@muxr/contract';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { DeviceV2Crypto, getCachedHostedGrant, refreshHostedGrant } from '@/state/hostedE2ee';
import { sync } from '@/sync/sync';
import { pluginSnapshot, refreshPlugins } from './pluginStore';

export interface PluginStream {
    onFrame: (listener: (frame: RealtimeHostFrame) => void) => () => void;
    onClose: (listener: (reason?: string) => void) => () => void;
    send: (frame: RealtimeClientFrame) => void;
    close: (reason?: string) => void;
}

/** Resolve a semantic stream capability without ever naming a provider/plugin id. */
export async function openPluginStream(
    capability: string,
    options: { sessionId?: string } = {},
): Promise<PluginStream> {
    await refreshPlugins();
    const matches = pluginSnapshot().filter(({ summary }) => summary.capabilities[capability] !== undefined);
    if (matches.length === 0) throw new Error(`${capability} plugin is unavailable or not approved`);
    if (matches.length > 1) throw new Error(`${capability} is claimed by multiple enabled plugins; disable all but one`);
    const { summary, manifest } = matches[0]!;
    const contributionId = summary.capabilities[capability]!;
    const contribution = manifest.contributions.find((candidate): candidate is PluginStreamCapability =>
        candidate.slot === 'host.stream' && candidate.id === contributionId);
    if (contribution === undefined) throw new Error(`${capability} capability is not a host.stream contribution`);

    const settings = getCachedConnectionSettings();
    let grant = settings.mode === 'hosted' ? getCachedHostedGrant(settings.machineId) : undefined;
    if (settings.mode === 'hosted' && grant === undefined) throw new Error('stream: hosted machine grant is missing');
    if (grant !== undefined && grant.expiresAt <= Date.now()) throw new Error('stream: device grant expired; pair again');
    if (grant !== undefined) {
        const latest = await refreshHostedGrant(settings.machineId, grant.credential);
        if (latest !== undefined && latest.keyVersion >= grant.keyVersion) {
            if (latest.expiresAt <= Date.now()) throw new Error('stream: device grant expired; pair again');
            grant = latest;
        }
    }
    const hosted = grant === undefined ? undefined : new DeviceV2Crypto(grant);
    const channel = newRealtimeChannel();
    await sync.request('plugin.stream', {
        pluginId: summary.pluginId,
        manifestHash: summary.manifestHash!,
        contributionId,
        channel,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    });

    const relayUrl = grant?.relayUrl ?? settings.relayUrl;
    const url = grant !== undefined
        ? ticketSocketUrl(relayUrl, await issueWsTicket({
            relayUrl,
            credential: grant.credential,
            machineId: settings.machineId,
            role: 'client',
            transport: 'stream',
            channel,
        }), 'stream')
        : settings.token === '' || settings.token.startsWith('acctok_')
          ? realtimeSocketUrl(relayUrl, {
              machineId: settings.machineId,
              channel,
              role: 'client',
              ...(settings.token === '' ? {} : { token: settings.token }),
          })
          : ticketSocketUrl(relayUrl, await issueWsTicket({
              relayUrl,
              credential: settings.token,
              machineId: settings.machineId,
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
                        if (envelope.header.machineId !== settings.machineId
                            || envelope.header.senderId !== settings.machineId
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
                    machineId: settings.machineId,
                    senderId: grant!.deviceId,
                    recipientId: settings.machineId,
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
