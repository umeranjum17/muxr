import {
    newRealtimeChannel,
    parseRealtimeClientFrame,
    parseRealtimeHostFrame,
    type PluginStreamCapability,
    type RealtimeClientFrame,
    type RealtimeHostFrame,
} from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';
import { getCachedHostedGrant, type StoredHostedGrant } from '@/pairing/e2ee';
import { sync } from '@/catalog/sync';
import { pluginSnapshot, refreshPlugins } from './application/pluginStore';

export interface PluginStream {
    onFrame: (listener: (frame: RealtimeHostFrame) => void) => () => void;
    onClose: (listener: (reason?: string) => void) => () => void;
    /** Begin delivery after listeners are installed. Safe and idempotent. */
    start: () => void;
    send: (frame: RealtimeClientFrame) => boolean;
    close: (reason?: string) => void;
}

type RealtimeStreamTransport = {
    write(line: string): Promise<void>;
    onLine(listener: (line: string) => void): () => void;
    onEnd(listener: (error?: string) => void): () => void;
    close(): void;
};

const MAX_PREACTIVATION_FRAMES = 512;
const MAX_PREACTIVATION_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_WIRE_FRAMES = 1024;
const MAX_PENDING_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_SEND_BUFFER_BYTES = 512 * 1024;

/**
 * Everything reconnect may use, captured once before the call opens. The
 * transport fields are shared by every realtime stream; a plugin stream adds
 * the catalog identity it must echo back to the host.
 */
export interface RealtimeStreamSnapshot {
    capability: string;
    machineId: string;
    relayUrl: string;
    mode: 'hosted' | 'local';
    token: string;
    grant?: StoredHostedGrant;
}

export interface PluginStreamSnapshot extends RealtimeStreamSnapshot {
    pluginId: string;
    manifestHash: string;
    contributionId: string;
}

/** Machine, relay and grant pins shared by plugin and product voice streams. */
export async function captureStreamTransport(capability: string, machineId: string): Promise<RealtimeStreamSnapshot> {
    const settings = { ...getCachedConnectionSettings() };
    if (settings.machineId !== machineId) throw new Error('End voice before switching computers.');
    const cachedGrant = settings.mode === 'hosted' ? getCachedHostedGrant(machineId) : undefined;
    if (settings.mode === 'hosted' && cachedGrant === undefined) throw new Error('stream: hosted machine grant is missing');
    if (getCachedConnectionSettings().machineId !== machineId) throw new Error('End voice before switching computers.');
    const grant = cachedGrant === undefined ? undefined : JSON.parse(JSON.stringify(cachedGrant)) as StoredHostedGrant;
    if (grant !== undefined && grant.expiresAt <= Date.now()) throw new Error('stream: device grant expired; pair again');
    return {
        capability,
        machineId,
        relayUrl: grant?.relayUrl ?? settings.relayUrl,
        mode: settings.mode,
        token: grant?.credential ?? settings.token,
        ...(grant === undefined ? {} : { grant }),
    };
}

export async function capturePluginStreamSnapshot(capability: string, machineId: string): Promise<PluginStreamSnapshot> {
    const transport = await captureStreamTransport(capability, machineId);
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
    return { ...transport, pluginId: summary.pluginId, manifestHash: summary.manifestHash, contributionId };
}

/** Refresh only the pinned machine's grant generation; never re-read the active machine or provider. */
export async function refreshPluginStreamSnapshot<T extends RealtimeStreamSnapshot>(snapshot: T): Promise<T> {
    if (getCachedConnectionSettings().machineId !== snapshot.machineId) throw new Error('End voice before switching computers.');
    if (snapshot.grant !== undefined && getCachedHostedGrant(snapshot.machineId)?.deviceId !== snapshot.grant.deviceId) {
        throw new Error('stream: pinned machine grant changed; pair again');
    }
    return snapshot;
}

/** Resolve a semantic stream capability without ever naming a provider/plugin id. */
export async function openPluginStream(
    capability: string,
    options: {
        sessionId?: string;
        machineId?: string;
        snapshot?: PluginStreamSnapshot;
    },
): Promise<PluginStream> {
    const snapshot = options.snapshot ?? await capturePluginStreamSnapshot(
        capability,
        options.machineId ?? getCachedConnectionSettings().machineId,
    );
    return openRealtimeStream(capability, {
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        snapshot,
        openStream: (params) => sync.openPluginStream({
            pluginId: snapshot.pluginId,
            manifestHash: snapshot.manifestHash,
            contributionId: snapshot.contributionId,
            ...params,
        }) ?? Promise.resolve(undefined),
    });
}

/**
 * Attach one realtime stream over the authenticated byokit duplex link.
 */
export async function openRealtimeStream(
    capability: string,
    options: {
        sessionId?: string;
        machineId?: string;
        snapshot?: RealtimeStreamSnapshot;
        openStream: (params: { channel: string; sessionId?: string }) => Promise<RealtimeStreamTransport | undefined>;
    },
): Promise<PluginStream> {
    const snapshot = options.snapshot ?? await captureStreamTransport(
        capability,
        options.machineId ?? getCachedConnectionSettings().machineId,
    );
    if (snapshot.capability !== capability) throw new Error('stream capability snapshot mismatch');
    const channel = newRealtimeChannel();
    if (getCachedConnectionSettings().machineId !== snapshot.machineId) throw new Error('End voice before switching computers.');
    const attachParams = { channel, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) };
    const streamTransport = await options.openStream(attachParams);
    if (streamTransport === undefined) throw new Error('stream: required duplex transport unavailable');
    if (getCachedConnectionSettings().machineId !== snapshot.machineId) {
        streamTransport.close();
        throw new Error('End voice before switching computers.');
    }

    const frameListeners = new Set<(frame: RealtimeHostFrame) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    const pendingFrames: Array<{ frame: RealtimeHostFrame; bytes: number }> = [];
    let pendingFrameBytes = 0;
    let transportEnded = false;
    let activated = false;
    let activating = false;
    let terminal: { reason?: string; notified: boolean } | undefined;
    let processing = Promise.resolve();
    let pendingWireFrames = 0;
    let pendingWireBytes = 0;
    let streamPendingBytes = 0;

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
        streamTransport.close();
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
            const frame = parseRealtimeHostFrame(JSON.parse(raw));
            if (frame.type === 'realtime.closed') finish(frame.reason);
            else deliverFrame(frame, new TextEncoder().encode(raw).length);
        } catch {
            finish('stream frame rejected');
        }
    };

    streamTransport.onLine((raw) => {
            if (terminal !== undefined) return;
            const wireBytes = new TextEncoder().encode(raw).length;
            if (pendingWireFrames >= MAX_PENDING_WIRE_FRAMES || pendingWireBytes + wireBytes > MAX_PENDING_WIRE_BYTES) {
                finish('stream receive buffer exceeded');
                return;
            }
            pendingWireFrames += 1;
            pendingWireBytes += wireBytes;
            processing = processing.then(async () => {
                try { await processMessage(raw); }
                finally { pendingWireFrames -= 1; pendingWireBytes -= wireBytes; }
            });
        });
    streamTransport.onEnd(endTransport);

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
            if (terminal !== undefined) return false;
            if (frame.type === 'realtime.audio' && streamPendingBytes > MAX_SEND_BUFFER_BYTES) return false;
            const wire = JSON.stringify(parseRealtimeClientFrame(frame));
            try {
                const bytes = new TextEncoder().encode(wire).byteLength + 1;
                streamPendingBytes += bytes;
                void streamTransport.write(wire).then(
                    () => { streamPendingBytes = Math.max(0, streamPendingBytes - bytes); },
                    () => finish('stream disconnected'),
                );
                return true;
            } catch {
                finish('stream disconnected');
                return false;
            }
        },
        close: (reason) => finish(reason, false),
    };
}
