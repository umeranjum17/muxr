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
    type RequestParams,
} from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';
import {
    DeviceV2Crypto,
    getCachedHostedGrant,
    refreshHostedGrant,
    type StoredHostedGrant,
} from '@/pairing/e2ee';
import { pluginSnapshot, refreshPlugins } from './application/pluginStore';

export interface PluginStream {
    onFrame: (listener: (frame: RealtimeHostFrame) => void) => () => void;
    onClose: (listener: (reason?: string) => void) => () => void;
    /** Begin delivery after listeners are installed. Safe and idempotent. */
    start: () => void;
    send: (frame: RealtimeClientFrame) => boolean;
    close: (reason?: string) => void;
}

const MAX_PREACTIVATION_FRAMES = 512;
const MAX_PREACTIVATION_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_WIRE_FRAMES = 1024;
const MAX_PENDING_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_SEND_BUFFER_BYTES = 512 * 1024;

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

/** Refresh only the pinned machine's grant generation; never re-read the active machine or provider. */
export async function refreshPluginStreamSnapshot(snapshot: PluginStreamSnapshot): Promise<PluginStreamSnapshot> {
    if (snapshot.grant === undefined) return snapshot;
    const refreshed = await refreshHostedGrant(snapshot.machineId, snapshot.token, snapshot.relayUrl);
    if (refreshed === undefined || refreshed.machineId !== snapshot.machineId || refreshed.deviceId !== snapshot.grant.deviceId) {
        throw new Error('stream: pinned machine grant could not be refreshed');
    }
    return {
        ...snapshot,
        token: refreshed.credential,
        grant: JSON.parse(JSON.stringify(refreshed)) as StoredHostedGrant,
    };
}

/** Resolve a semantic stream capability without ever naming a provider/plugin id. */
export async function openPluginStream(
    capability: string,
    options: {
        sessionId?: string;
        machineId?: string;
        snapshot?: PluginStreamSnapshot;
        requestControl: (params: RequestParams<'plugin.stream'>) => Promise<unknown>;
    },
): Promise<PluginStream> {
    const snapshot = options.snapshot ?? await capturePluginStreamSnapshot(
        capability,
        options.machineId ?? getCachedConnectionSettings().machineId,
    );
    if (snapshot.capability !== capability) throw new Error('stream capability snapshot mismatch');
    const grant = snapshot.grant;
    const hosted = grant === undefined ? undefined : new DeviceV2Crypto(grant);
    const channel = newRealtimeChannel();
    if (getCachedConnectionSettings().machineId !== snapshot.machineId) throw new Error('End voice before switching computers.');
    // Reuse the main relay client: a second socket receives the same encrypted broadcasts
    // and can lose the shared replay race before its plugin.stream result arrives.
    await options.requestControl({
        pluginId: snapshot.pluginId,
        manifestHash: snapshot.manifestHash,
        contributionId: snapshot.contributionId,
        channel,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    });
    if (getCachedConnectionSettings().machineId !== snapshot.machineId) throw new Error('End voice before switching computers.');

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
    const pendingFrames: Array<{ frame: RealtimeHostFrame; bytes: number }> = [];
    let pendingFrameBytes = 0;
    let socket: WebSocket | undefined;
    let opened = false;
    let transportEnded = false;
    let activated = false;
    let activating = false;
    let terminal: { reason?: string; notified: boolean } | undefined;
    let processing = Promise.resolve();
    let pendingWireFrames = 0;
    let pendingWireBytes = 0;
    let replayReleased = false;

    const notifyTerminal = (): void => {
        if (!activated || activating || terminal === undefined || terminal.notified) return;
        terminal.notified = true;
        for (const listener of [...closeListeners]) {
            try { listener(terminal.reason); } catch { /* listeners do not own transport ordering */ }
        }
    };
    const finish = (reason?: string, retainPending = true): void => {
        if (terminal !== undefined) return;
        terminal = { ...(reason === undefined ? {} : { reason }), notified: false };
        if (!retainPending) {
            pendingFrames.length = 0;
            pendingFrameBytes = 0;
        }
        if (!replayReleased) {
            replayReleased = true;
            hosted?.release('stream', channel);
        }
        const current = socket;
        socket = undefined;
        if (current !== undefined) {
            current.onopen = null;
            current.onmessage = null;
            current.onerror = null;
            current.onclose = null;
            current.close();
        }
        notifyTerminal();
    };
    const endTransport = (): void => {
        if (transportEnded || terminal !== undefined) return;
        transportEnded = true;
        const preceding = processing;
        void preceding.then(() => {
            if (terminal === undefined) finish('stream disconnected');
        });
    };
    const dispatchFrame = (frame: RealtimeHostFrame): void => {
        for (const listener of [...frameListeners]) {
            try { listener(frame); } catch { /* one listener cannot reorder the stream */ }
        }
    };
    const deliverFrame = (frame: RealtimeHostFrame, bytes: number): void => {
        if (activated) {
            dispatchFrame(frame);
            return;
        }
        if (pendingFrames.length >= MAX_PREACTIVATION_FRAMES || pendingFrameBytes + bytes > MAX_PREACTIVATION_BYTES) {
            finish('stream activation buffer exceeded');
            return;
        }
        pendingFrames.push({ frame, bytes });
        pendingFrameBytes += bytes;
    };
    const processMessage = async (raw: string): Promise<void> => {
        if (terminal !== undefined) return;
        try {
            let text = raw;
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
            if (frame.type === 'realtime.closed') finish(frame.reason);
            else deliverFrame(frame, new TextEncoder().encode(text).length);
        } catch {
            finish('stream frame rejected');
        }
    };

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            finish('stream connection timed out', false);
            reject(new Error('stream connection timed out'));
        }, 15_000);
        const next = new WebSocket(url);
        socket = next;
        next.onopen = () => {
            clearTimeout(timer);
            if (terminal !== undefined || socket !== next) return;
            opened = true;
            resolve();
        };
        next.onerror = () => {
            clearTimeout(timer);
            if (!opened) {
                finish('stream connection failed', false);
                reject(new Error('stream connection failed'));
            } else {
                endTransport();
            }
        };
        next.onclose = () => {
            clearTimeout(timer);
            if (socket !== next || terminal !== undefined) return;
            endTransport();
        };
        next.onmessage = (event) => {
            if (terminal !== undefined || socket !== next) return;
            const raw = String(event.data);
            const wireBytes = new TextEncoder().encode(raw).length;
            if (pendingWireFrames >= MAX_PENDING_WIRE_FRAMES || pendingWireBytes + wireBytes > MAX_PENDING_WIRE_BYTES) {
                finish('stream receive buffer exceeded');
                return;
            }
            pendingWireFrames += 1;
            pendingWireBytes += wireBytes;
            processing = processing.then(async () => {
                try {
                    await processMessage(raw);
                } finally {
                    pendingWireFrames -= 1;
                    pendingWireBytes -= wireBytes;
                }
            });
        };
    });

    return {
        onFrame: (listener) => {
            frameListeners.add(listener);
            return () => frameListeners.delete(listener);
        },
        onClose: (listener) => {
            closeListeners.add(listener);
            if (activated && terminal?.notified === true) {
                try { listener(terminal.reason); } catch { /* listener-owned */ }
            }
            return () => closeListeners.delete(listener);
        },
        start: () => {
            if (activated) return;
            activated = true;
            activating = true;
            const terminalBeforeActivation = terminal;
            for (const { frame } of pendingFrames.splice(0)) {
                if (terminalBeforeActivation === undefined && terminal !== undefined) break;
                dispatchFrame(frame);
            }
            pendingFrameBytes = 0;
            activating = false;
            notifyTerminal();
        },
        send: (frame) => {
            if (terminal !== undefined || socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
            if (frame.type === 'realtime.audio' && socket.bufferedAmount > MAX_SEND_BUFFER_BYTES) return false;
            const clean = parseRealtimeClientFrame(frame);
            const plaintext = JSON.stringify(clean);
            const sealed = hosted?.seal('stream', channel, plaintext);
            try {
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
                return true;
            } catch {
                finish('stream disconnected');
                return false;
            }
        },
        close: (reason) => finish(reason, false),
    };
}
