/**
 * The machine host.
 *
 * Owns the session domain and forwards its events to the relay VERBATIM. There
 * is deliberately no projection/adapter step here -- the moment one appears,
 * events start getting dropped and transcripts start feeling thin.
 */

import type { ClientFrame, ClientRequest, SessionEvent, SessionEventBody } from '@muxr/contract';
import { connectToRelay, deviceTableCanMutate, type RelayLink, type HostedMachineKeys } from './machine/index.js';
import { createRequestDispatcher } from './requests/index.js';
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

function responseChannel(frameType: string): 'attachment' | 'session' {
    return frameType === 'attachment.read' ? 'attachment' : 'session';
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
    onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'replaced') => void;
    /** Mandatory strict v2 endpoint keys for hosted mode. */
    hostedE2ee?: HostedMachineKeys;
    token?: string;
    peerRuntime?: PeerRuntime;
    diagnostics?: HostDiagnosticsJournal;
}

export interface Host {
    close: () => Promise<void>;
}

export function startHost(options: HostOptions): Host {
    const { source, domain } = options;
    const hostVersion = options.hostVersion ?? '0.0.0';
    const seqBySession = new Map<string, number>();
    let link: RelayLink | undefined;

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
    const dispatcher = createRequestDispatcher({
        source,
        domain,
        machineId: options.machineId,
        ...(options.machineName === undefined ? {} : { machineName: options.machineName }),
        hostVersion,
        relayUrl: options.relayUrl,
        ...(options.terminals === undefined ? {} : { terminals: options.terminals }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.peerRuntime === undefined ? {} : { peerRuntime: options.peerRuntime }),
        ...hostedDispatcherOptions,
    });

    function nextSeq(sessionId: string): number {
        const seq = (seqBySession.get(sessionId) ?? 0) + 1;
        seqBySession.set(sessionId, seq);
        return seq;
    }

    async function handleClientFrame(frame: ClientFrame, authenticatedSenderId?: string): Promise<void> {
        const clientKind = diagnosticClientKind(authenticatedSenderId, options.hostedE2ee);
        options.diagnostics?.client(authenticatedSenderId ?? 'local', clientKind, frame.type === 'client.hello');
        const peerRecipient = peerRecipientFor(authenticatedSenderId, options.hostedE2ee);
        if (options.hostedE2ee !== undefined && frame.type === 'terminal.attach'
            && frame.params.deviceId !== authenticatedSenderId) {
            throw new Error('terminal: device grant does not match the authenticated client');
        }
        if (frame.type === 'client.hello') {
            const peerMayList = peerRecipient === undefined
                || options.hostedE2ee?.deviceCapabilities?.[peerRecipient]?.includes('list') === true;
            if (peerMayList) {
                const listed = await listAgents(source, {});
                if (listed.ok) {
                    link?.send({ type: 'session.list', sessions: listed.data }, undefined, 'session', peerRecipient);
                }
            }
            if (peerRecipient === undefined) source.resendCumulativeState?.();
            return;
        }
        const startedAt = Date.now();
        let response;
        try {
            response = await dispatcher.dispatch(frame as ClientRequest, authenticatedSenderId);
        } catch (error) {
            options.diagnostics?.request(frame.type, clientKind, 'unavailable', Date.now() - startedAt);
            throw error;
        }
        const outcome = response.ok ? 'ok' : 'rejected';
        options.diagnostics?.request(frame.type, clientKind, outcome, Date.now() - startedAt, response.ok ? undefined : response.code);
        if (frame.type.startsWith('peer.') && options.peerRuntime !== undefined) {
            options.diagnostics?.relationships(options.peerRuntime.store.list().peers);
        }
        link?.send(response, sessionIdFrom(frame), responseChannel(frame.type), peerRecipient);
    }

    link = connectToRelay({
        relayUrl: options.relayUrl,
        machineId: options.machineId,
        ...(options.hostedE2ee === undefined ? {} : { hostedE2ee: options.hostedE2ee }),
        ...(options.token === undefined ? {} : { token: options.token }),
        onPeerIngress: (outcome) => options.diagnostics?.peerIngress(outcome),
        onStateChange: (state) => {
            options.diagnostics?.relay(state);
            options.onStateChange?.(state);
            if (state === 'open') {
                link?.send({
                    type: 'machine.hello',
                    machineId: options.machineId,
                    hostVersion,
                });
                // The watcher's first scan races this link: hashing a 250MB
                // attachment outlives the connect, so the emit lands while
                // link is still undefined and is dropped. The signature guard
                // then suppresses every later emit, leaving clients pinned to
                // ids from a previous host run until a file happens to change.
                // Clients do not reconnect when the host restarts, so waiting
                // for client.hello never rescues them.
                source.resendCumulativeState?.();
            }
        },
        onClientFrame: (frame, authenticatedSenderId) => {
            void handleClientFrame(frame, authenticatedSenderId).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                const sessionId = sessionIdFrom(frame);
                if (typeof frame === 'object' && frame !== null && 'requestId' in frame && typeof frame.requestId === 'string') {
                    link?.send(
                        { type: 'result', requestId: frame.requestId, ok: false, error: message },
                        sessionId,
                        responseChannel(frame.type),
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
        link?.send({ type: 'session.event', sessionId, event }, sessionId);
        if (body.type === 'session.removed') domain.unread.acknowledge(sessionId);
        else domain.unread.noteActivity(sessionId, '');
    }

    const unsubscribe = source.subscribe(forward);
    const unsubscribeMachine = source.subscribeMachine?.((frame) => link?.send(frame));

    return {
        close: async () => {
            unsubscribe();
            unsubscribeMachine?.();
            link?.close();
            await source.dispose();
        },
    };
}
