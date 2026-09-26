/**
 * The machine host.
 *
 * Owns the session domain and forwards its events to the relay VERBATIM. There
 * is deliberately no projection/adapter step here -- the moment one appears,
 * events start getting dropped and transcripts start feeling thin.
 */

import { routingChannelForRequest, type ClientFrame, type ClientRequest, type HostFrame, type SessionEvent, type SessionEventBody } from '@muxr/contract';
import { connectToRelay, deviceTableCanMutate, type RelayLink, type RelayStateCode, type HostedMachineKeys } from './machine/index.js';
import { createRequestDispatcher, viewOnlyRequestAllowed } from './requests/index.js';
import { DesktopSessions } from './desktop/index.js';
import { listAgents, type AgentWatchStores, type SessionSource, type TerminalManager } from './agent/index.js';
import type { PeerRuntime } from './peer/index.js';
import type { DiagnosticClientKind, HostDiagnosticsJournal } from './diagnostics/index.js';

function sessionIdFrom(frame: { type?: string; params?: unknown } | null | undefined): string | undefined {
    if (frame === null || typeof frame !== 'object') return undefined;
    if (typeof frame.params !== 'object' || frame.params === null) return undefined;
    if (!('sessionId' in frame.params) || typeof frame.params.sessionId !== 'string') return undefined;
    return frame.params.sessionId;
}

function peerRecipientFor(senderId: string | undefined, hostedE2ee: HostedMachineKeys | undefined): string | undefined {
    if (senderId === undefined) return undefined;
    if (hostedE2ee?.deviceKinds?.[senderId] !== 'peer') return undefined;
    return senderId;
}

function diagnosticClientKind(senderId: string | undefined, hostedE2ee: HostedMachineKeys | undefined): DiagnosticClientKind {
    if (senderId === undefined) return 'local';
    return hostedE2ee?.deviceKinds?.[senderId] ?? 'unknown';
}

export interface HostOptions {
    relayUrl: string;
    machineId: string;
    machineName?: string;
    source: SessionSource;
    domain: AgentWatchStores;
    terminals?: TerminalManager;
    hostVersion?: string;
    linkEnrolledKey?: (deviceId: string) => string | undefined;
    connectionMode?: string;
    onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'replaced', code?: RelayStateCode) => void;
    /** Mandatory strict v2 endpoint keys for hosted mode. */
    hostedE2ee?: HostedMachineKeys;
    token?: string;
    peerRuntime?: PeerRuntime;
    diagnostics?: HostDiagnosticsJournal;
    /** Overrides the desktop engine path; a test can point at its own build. */
    desktopEnginePath?: string;
    /** Existing host state root for local desktop portal grants. */
    stateRoot?: string;
}

export interface Host {
    close: () => Promise<void>;
    /** The host's reply to one client frame, for a transport that returns replies itself (the link). */
    answer: (frame: ClientFrame, authenticatedSenderId: string, connectionId?: string) => Promise<HostFrame | undefined>;
    setLinkDesktopConnection: (connectionId: string, active: boolean) => void;
    setLinkDeviceConnection: (deviceId: string, active: boolean) => void;
    closeDeviceDesktopSessions: (deviceId: string) => Promise<void>;
    canView: (frame: ClientFrame) => boolean;
    /** Every frame the relay transport broadcasts to all clients, for a second transport to broadcast too. */
    onBroadcast: (listener: (frame: HostFrame) => void) => void;
    refreshLinkEnrolment: () => void;
}

export function startHost(options: HostOptions): Host {
    const { source, domain } = options;
    const hostVersion = options.hostVersion ?? '0.0.0';
    const seqBySession = new Map<string, number>();
    let link: RelayLink | undefined;
    const activeDesktopConnections = new Set<string>();

    let hostedDispatcherOptions = {};
    if (options.hostedE2ee !== undefined) {
        const hosted = options.hostedE2ee;
        hostedDispatcherOptions = {
            requirePreviewEncryption: true,
            canMutateDevice: (deviceId: string) => deviceTableCanMutate(hosted.deviceAuthorities, deviceId),
            getDeviceContext: (deviceId: string) => {
                const kind = hosted.deviceKinds?.[deviceId];
                if (kind === undefined) return undefined;
                const capabilities = hosted.deviceCapabilities?.[deviceId];
                const allowedCwds = hosted.deviceAllowedCwds?.[deviceId];
                return {
                    kind,
                    ...(capabilities === undefined ? {} : { capabilities }),
                    ...(allowedCwds === undefined ? {} : { allowedCwds }),
                };
            },
        };
    }
    // Started lazily: a host that never opens a desktop never spawns the engine.
    const desktop = new DesktopSessions(
        {
            ...(options.desktopEnginePath === undefined ? {} : { enginePath: options.desktopEnginePath }),
            ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
            // The engine's own account of a failure (a refused portal, a
            // missing library) belongs in the host's log with everything else.
            onDiagnostic: (line) => process.stderr.write(`desktop engine: ${line}\n`),
        },
    );
    const dispatcher = createRequestDispatcher({
        source,
        domain,
        machineId: options.machineId,
        ...(options.machineName === undefined ? {} : { machineName: options.machineName }),
        hostVersion,
        ...(options.connectionMode === undefined ? {} : { connectionMode: options.connectionMode }),
        ...(options.hostedE2ee === undefined ? {} : { pairedDeviceCount: () => Object.entries(options.hostedE2ee!.deviceKinds ?? {})
            .filter(([id, kind]) => kind !== 'peer' && (options.hostedE2ee!.deviceExpiresAt?.[id] ?? 0) > Date.now()).length }),
        relayUrl: options.relayUrl,
        ...(options.terminals === undefined ? {} : { terminals: options.terminals }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.peerRuntime === undefined ? {} : { peerRuntime: options.peerRuntime }),
        desktop,
        isDesktopConnectionActive: (id: string) => activeDesktopConnections.has(id),
        ...hostedDispatcherOptions,
    });

    function nextSeq(sessionId: string): number {
        const seq = (seqBySession.get(sessionId) ?? 0) + 1;
        seqBySession.set(sessionId, seq);
        return seq;
    }

    const broadcastListeners = new Set<(frame: HostFrame) => void>();
    function broadcast(frame: HostFrame, sessionId?: string): void {
        if (sessionId === undefined) link?.send(frame);
        else link?.send(frame, sessionId);
        for (const listener of broadcastListeners) listener(frame);
    }

    /** What the host replies to one frame; the caller's transport decides where the reply goes. */
    async function answerFrame(frame: ClientFrame, authenticatedSenderId?: string, connectionId?: string, transport: 'link' | 'relay' = 'relay'): Promise<HostFrame | undefined> {
        const clientKind = diagnosticClientKind(authenticatedSenderId, options.hostedE2ee);
        options.diagnostics?.client(authenticatedSenderId ?? 'local', clientKind, frame.type === 'client.hello');
        const startedAt = Date.now();
        const peerRecipient = peerRecipientFor(authenticatedSenderId, options.hostedE2ee);
        if (options.hostedE2ee !== undefined && frame.type === 'terminal.attach'
            && frame.params.deviceId !== authenticatedSenderId) {
            const error = new Error('terminal: device grant does not match the authenticated client') as Error & { code: string };
            error.code = 'e2ee-required';
            options.diagnostics?.request(frame.type, clientKind, 'rejected', Date.now() - startedAt, error.code);
            throw error;
        }
        if (frame.type.startsWith('desktop.') && transport !== 'link') {
            throw new Error('desktop signaling requires the byokit link');
        }
        if (frame.type.startsWith('desktop.') && (connectionId === undefined || !activeDesktopConnections.has(connectionId))) {
            throw new Error('the requesting phone is no longer connected');
        }
        if (frame.type === 'client.hello') {
            const peerMayList = peerRecipient === undefined
                || options.hostedE2ee?.deviceCapabilities?.[peerRecipient]?.includes('list') === true;
            if (!peerMayList) return undefined;
            const listed = await listAgents(source, {});
            return listed.ok ? { type: 'session.list', sessions: listed.data } : undefined;
        }

        let response;
        try {
            response = await dispatcher.dispatch(frame as ClientRequest, authenticatedSenderId, connectionId);
        } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
            options.diagnostics?.request(frame.type, clientKind, 'unavailable', Date.now() - startedAt, code);
            throw error;
        }
        const outcome = response.ok ? 'ok' : 'rejected';
        options.diagnostics?.request(frame.type, clientKind, outcome, Date.now() - startedAt, response.ok ? undefined : response.code);
        if (frame.type.startsWith('peer.') && options.peerRuntime !== undefined) {
            options.diagnostics?.relationships(options.peerRuntime.store.list().peers);
        }
        if (frame.type === 'herdr.tree' && response.ok && authenticatedSenderId !== undefined) {
            const key = options.linkEnrolledKey?.(authenticatedSenderId);
            if (key !== undefined) return { ...response, data: { ...(response.data as object), linkEnrolledKey: key } };
        }
        return response;
    }

    async function handleClientFrame(frame: ClientFrame, authenticatedSenderId?: string, connectionId?: string): Promise<void> {
        const peerRecipient = peerRecipientFor(authenticatedSenderId, options.hostedE2ee);
        const response = await answerFrame(frame, authenticatedSenderId, connectionId, 'relay');
        if (frame.type === 'client.hello') {
            if (response !== undefined) link?.send(response, undefined, 'session', peerRecipient);
            if (peerRecipient === undefined) source.resendCumulativeState?.();
            return;
        }
        if (response === undefined) return;
        const channel = routingChannelForRequest(frame.type);
        // Artifact chunks go to the socket that asked: broadcast, every other
        // phone and browser paired to this machine pulled the whole file too.
        link?.send(response, sessionIdFrom(frame), channel, peerRecipient, channel === 'attachment' ? connectionId : undefined);
    }

    link = connectToRelay({
        relayUrl: options.relayUrl,
        machineId: options.machineId,
        ...(options.hostedE2ee === undefined ? {} : { hostedE2ee: options.hostedE2ee }),
        ...(options.token === undefined ? {} : { token: options.token }),
        onPeerIngress: (outcome) => options.diagnostics?.peerIngress(outcome),
        onClientReject: (clientKey, kind, outcome) => options.diagnostics?.clientReject(clientKey, kind, outcome),
        onStateChange: (state, code) => {
            options.diagnostics?.relay(state, code);
            options.onStateChange?.(state, code);
            if (state === 'open') {
                refreshLinkEnrolment();
                // The watcher's first scan races this link: hashing a 250MB
                // artifact outlives the connect, so the emit lands while
                // link is still undefined and is dropped. The signature guard
                // then suppresses every later emit, leaving clients pinned to
                // ids from a previous host run until a file happens to change.
                // Clients do not reconnect when the host restarts, so waiting
                // for client.hello never rescues them.
                source.resendCumulativeState?.();
            }
        },
        onClientFrame: (frame, authenticatedSenderId, connectionId) => {
            void handleClientFrame(frame, authenticatedSenderId, connectionId).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
                const sessionId = sessionIdFrom(frame);
                if (typeof frame === 'object' && frame !== null && 'requestId' in frame && typeof frame.requestId === 'string') {
                    link?.send(
                        { type: 'result', requestId: frame.requestId, ok: false, error: message, ...(code === undefined ? {} : { code }) },
                        sessionId,
                        routingChannelForRequest(frame.type),
                        peerRecipientFor(authenticatedSenderId, options.hostedE2ee),
                    );
                    return;
                }
                if (sessionId !== undefined) forward(sessionId, { type: 'session.error', message });
            });
        },
    });

    function forward(sessionId: string, body: SessionEventBody): void {
        const event: SessionEvent = { ...body, seq: nextSeq(sessionId) };
        broadcast({ type: 'session.event', sessionId, event }, sessionId);
        if (body.type === 'session.removed') domain.unread.acknowledge(sessionId);
        else domain.unread.noteActivity(sessionId, '');
    }

    function refreshLinkEnrolment(): void {
        link?.send({ type: 'machine.hello', machineId: options.machineId, hostVersion });
    }

    const unsubscribe = source.subscribe(forward);
    const unsubscribeMachine = source.subscribeMachine?.((frame) => broadcast(frame));

    return {
        canView: (frame) => frame.type === 'client.hello' || viewOnlyRequestAllowed(frame as ClientRequest, source),
        answer: async (frame, authenticatedSenderId, connectionId) => {
            const response = await answerFrame(frame, authenticatedSenderId, connectionId, 'link');
            if (frame.type === 'client.hello') source.resendCumulativeState?.();
            return response;
        },
        setLinkDesktopConnection: (connectionId, active) => {
            if (active) activeDesktopConnections.add(connectionId);
            else activeDesktopConnections.delete(connectionId);
        },
        setLinkDeviceConnection: (deviceId, active) => desktop.setLinkDeviceConnected(deviceId, active),
        closeDeviceDesktopSessions: (deviceId) => desktop.revokeDevice(deviceId),
        onBroadcast: (listener) => { broadcastListeners.add(listener); },
        refreshLinkEnrolment,
        close: async () => {
            unsubscribe();
            unsubscribeMachine?.();
            link?.close();
            await desktop.closeAll();
            desktop.stopVirtualDisplay();
            await source.dispose();
        },
    };
}
