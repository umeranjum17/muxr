/**
 * The machine host.
 *
 * Owns the session domain and forwards its events to the relay VERBATIM. There
 * is deliberately no projection/adapter step here -- the moment one appears,
 * events start getting dropped and transcripts start feeling thin.
 */

import type { ClientFrame, ClientRequest, SessionEvent, SessionEventBody } from '@muxr/contract';
import { connectToRelay, deviceTableCanMutate, deviceTableHoldsControl, type RelayLink, type RelayStateCode, type HostedMachineKeys } from './machine/index.js';
import { createRequestDispatcher, surfaceOfferFrame, type RequestDispatcherOptions, type SurfaceOfferEvent } from './requests/index.js';
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
    /** Shared Surface offer registry. One is created when absent. */
    surfaceOffers?: RequestDispatcherOptions['surfaceOffers'];
    previewEndpoints?: RequestDispatcherOptions['previewEndpoints'];
    previewGateway?: RequestDispatcherOptions['previewGateway'];
    onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'replaced', code?: RelayStateCode) => void;
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
            // Surfaces read the grant itself, not the absence of a "view-only"
            // note: removing a grant leaves no authority entry behind, and the
            // tables are refreshed in place as pairing rewrites them, so this
            // is the live answer every sweep.
            surfaceAuthority: (deviceId: string) => deviceTableHoldsControl(hosted, deviceId),
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
        ...(options.surfaceOffers === undefined ? {} : { surfaceOffers: options.surfaceOffers }),
        ...(options.previewEndpoints === undefined ? {} : { previewEndpoints: options.previewEndpoints }),
        ...(options.previewGateway === undefined ? {} : { previewGateway: options.previewGateway }),
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

    /**
     * Fan a Surface registry event out as a host-originated frame on the
     * session channel. Sessionless records emit nothing. An offer carries no
     * credential: acting on one still needs a control grant and a lease the
     * host issues to that exact device, so an observe grant that can read
     * the frame can do nothing with it.
     */
    // ponytail: broadcast under the shared session root; per-recipient
    // sealing (so observe grants cannot even read offers) needs the directed
    // egress key on both ends -- add when offers start carrying anything a
    // view-only device must not see.
    function emitSurfaceOffer(operation: SurfaceOfferEvent['operation'], record: SurfaceOfferEvent['record']): void {
        const frame = surfaceOfferFrame({ operation, record });
        if (frame === undefined || record.sessionId === undefined) return;
        link?.send(frame, record.sessionId, 'session');
    }
    if (options.surfaceOffers !== undefined) {
        options.surfaceOffers.onEvent = (event) => emitSurfaceOffer(event.operation, event.record);
    }

    async function handleClientFrame(frame: ClientFrame, authenticatedSenderId?: string): Promise<void> {
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
            // A device rejoining an already-connected host missed every
            // offer frame while it was gone; replay the current offers.
            // Coordinators apply them idempotently.
            for (const record of options.surfaceOffers?.records() ?? []) {
                emitSurfaceOffer('open', record);
            }
            return;
        }

        let response;
        try {
            response = await dispatcher.dispatch(frame as ClientRequest, authenticatedSenderId);
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
        link?.send(response, sessionIdFrom(frame), responseChannel(frame.type), peerRecipient);
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
                // A reconnected phone missed every offer frame while it was
                // gone. Replay the current offers to the devices that may
                // hold them now; nothing replayed is claimed visible before
                // the device acknowledges it.
                for (const record of options.surfaceOffers?.records() ?? []) {
                    emitSurfaceOffer('open', record);
                }
            }
        },
        onClientFrame: (frame, authenticatedSenderId) => {
            void handleClientFrame(frame, authenticatedSenderId).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
                const sessionId = sessionIdFrom(frame);
                if (typeof frame === 'object' && frame !== null && 'requestId' in frame && typeof frame.requestId === 'string') {
                    link?.send(
                        { type: 'result', requestId: frame.requestId, ok: false, error: message, ...(code === undefined ? {} : { code }) },
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
