/**
 * The machine host.
 *
 * Owns the session domain and forwards its events to the relay VERBATIM. There
 * is deliberately no projection/adapter step here -- the moment one appears,
 * events start getting dropped and transcripts start feeling thin.
 */

import type { ClientFrame, ClientRequest, SessionEvent, SessionEventBody } from '@muxr/contract';
import { connectToRelay, type RelayLink } from './relayLink.js';
import { createRequestDispatcher } from './requests/createRequestDispatcher.js';
import type { DomainStores } from './domain/index.js';
import type { TerminalManager } from './herdr/terminalManager.js';
import type { SessionSource } from './sessionSource.js';
import type { HostedMachineKeys } from './hostedE2ee.js';

export interface HostOptions {
    relayUrl: string;
    machineId: string;
    machineName?: string;
    source: SessionSource;
    domain: DomainStores;
    terminals?: TerminalManager;
    hostVersion?: string;
    onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'replaced') => void;
    /** Mandatory strict v2 endpoint keys for hosted mode. */
    hostedE2ee?: HostedMachineKeys;
    token?: string;
}

export interface Host {
    close: () => Promise<void>;
}

export function startHost(options: HostOptions): Host {
    const { source, domain } = options;
    const hostVersion = options.hostVersion ?? '0.0.0';
    const seqBySession = new Map<string, number>();
    let link: RelayLink | undefined;

    const dispatcher = createRequestDispatcher({
        source,
        domain,
        machineId: options.machineId,
        ...(options.machineName === undefined ? {} : { machineName: options.machineName }),
        hostVersion,
        relayUrl: options.relayUrl,
        ...(options.terminals === undefined ? {} : { terminals: options.terminals }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.hostedE2ee === undefined ? {} : {
            requirePreviewEncryption: true,
            canMutateDevice: (deviceId: string) => options.hostedE2ee!.deviceAuthorities?.[deviceId] !== 'observe',
        }),
    });

    function nextSeq(sessionId: string): number {
        const seq = (seqBySession.get(sessionId) ?? 0) + 1;
        seqBySession.set(sessionId, seq);
        return seq;
    }

    async function handleClientFrame(frame: ClientFrame, authenticatedSenderId?: string): Promise<void> {
        if (options.hostedE2ee !== undefined && frame.type === 'terminal.attach'
            && frame.params.deviceId !== authenticatedSenderId) {
            throw new Error('terminal: device grant does not match the authenticated client');
        }
        if (frame.type === 'client.hello') {
            link?.send({ type: 'session.list', sessions: await source.list({}) });
            source.resendCumulativeState?.();
            return;
        }
        const response = await dispatcher.dispatch(frame as ClientRequest, authenticatedSenderId);
        const sessionId = 'params' in frame && typeof frame.params === 'object' && frame.params !== null
            && 'sessionId' in frame.params && typeof frame.params.sessionId === 'string' ? frame.params.sessionId : undefined;
        if (frame.type === 'attachment.prepare') {
            console.log(`[attachment-download] host answering req=${frame.requestId} ok=${response.ok}`);
        }
        link?.send(response, sessionId, frame.type === 'attachment.read' ? 'attachment' : 'session');
    }

    link = connectToRelay({
        relayUrl: options.relayUrl,
        machineId: options.machineId,
        ...(options.hostedE2ee === undefined ? {} : { hostedE2ee: options.hostedE2ee }),
        ...(options.token === undefined ? {} : { token: options.token }),
        onStateChange: (state) => {
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
                if ('requestId' in frame && typeof frame.requestId === 'string') {
                    const errorSessionId = 'params' in frame && typeof frame.params === 'object' && frame.params !== null
                        && 'sessionId' in frame.params && typeof frame.params.sessionId === 'string' ? frame.params.sessionId : undefined;
                    link?.send(
                        { type: 'result', requestId: frame.requestId, ok: false, error: message },
                        errorSessionId,
                        frame.type === 'attachment.read' ? 'attachment' : 'session',
                    );
                    return;
                }
                const sessionId =
                    'params' in frame &&
                    typeof frame.params === 'object' &&
                    frame.params !== null &&
                    'sessionId' in frame.params &&
                    typeof frame.params.sessionId === 'string'
                        ? frame.params.sessionId
                        : undefined;
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
