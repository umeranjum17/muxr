/**
 * The machine host's outbound link to the relay.
 *
 * Outbound-only by design: the host opens the connection, so there is no inbound
 * port, no NAT traversal, and no firewall rule on the user's machine.
 */

import WebSocket from 'ws';
import { v2EnvelopeSequence } from '@muxr/crypto';
import { HostV2Crypto, type HostedMachineKeys } from './hostedE2ee.js';
import { loopbackMachineSocketUrl } from './loopbackWsAuth.js';
import { reconnectMachine } from '../application/reconnectMachine.js';
import type {
    DiagnosticClientKind,
    DiagnosticClientRejectOutcome,
    DiagnosticPeerIngressOutcome,
} from '../../diagnostics/index.js';
import {
    decodePayload,
    encodePayload,
    RELAY_CLOSE_REPLACED,
    type ClientFrame,
    type Envelope,
    type HostFrame,
    issueWsTicket,
    parseClientFrame,
    ticketSocketUrl,
    WsTicketError,
} from '@muxr/contract';

export type RelayStateCode = 'ticket-issue-failed' | 'socket-closed' | 'socket-error' | 'replaced';

function ticketStateCode(_error: unknown): RelayStateCode {
    return 'ticket-issue-failed';
}

function closeStateCode(code: number): RelayStateCode {
    if (code === RELAY_CLOSE_REPLACED) return 'replaced';
    return code === 1000 || code === 1001 ? 'socket-closed' : 'socket-error';
}
export interface RelayLinkOptions {
    relayUrl: string;
    machineId: string;
    onClientFrame: (frame: ClientFrame, authenticatedSenderId?: string) => void;
    onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'replaced', code?: RelayStateCode) => void;
    onClientReject?: (clientKey: string, kind: DiagnosticClientKind, outcome: DiagnosticClientRejectOutcome) => void;
    onPeerIngress?: (outcome: DiagnosticPeerIngressOutcome) => void;
    /** ponytail: fixed backoff. Make it adaptive when a real network says so. */
    reconnectDelayMs?: number;
    /** Mandatory strict v2 keys in hosted mode. */
    hostedE2ee?: HostedMachineKeys;
    /**
     * Machine token from POST /v1/machines. Required whenever the relay runs in
     * strict auth, which is every non-loopback deployment.
     */
    token?: string;
}

export interface RelayLink {
    send: (frame: HostFrame, sessionId?: string, channel?: 'session' | 'attachment', recipientId?: string) => void;
    close: () => void;
}

export function connectToRelay(options: RelayLinkOptions): RelayLink {
    const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    const hosted = options.hostedE2ee === undefined ? undefined : new HostV2Crypto(options.hostedE2ee);
    let socket: WebSocket | undefined;
    let seq = 0;
    let closed = false;
    let reconnectAttempt = 0;
    let permanentAuthReported = false;
    const retryDelay = (): number => Math.min(reconnectDelayMs * 2 ** reconnectAttempt++, 30_000);
    /** Frames that arrived while the socket was down. Hello still goes first. */
    const outbound: Array<{ frame: HostFrame; sessionId?: string; channel: 'session' | 'attachment'; recipientId?: string }> = [];
    const MAX_OUTBOUND = 64;

    function transmit(frame: HostFrame, sessionId: string | undefined, channel: 'session' | 'attachment', recipientId?: string): void {
        if (socket?.readyState !== WebSocket.OPEN) return;
        seq += 1;
        const plaintext = encodePayload(frame);
        const streamId = sessionId ?? 'machine';
        // Local development is cleartext. User-operated and hosted connections
        // always use the strict encrypted envelope.
        const payload = hosted === undefined ? plaintext : hosted.seal(channel, streamId, plaintext, recipientId);
        const envelope: Envelope = {
            header: {
                machineId: options.machineId,
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(hosted === undefined ? {} : {
                    senderId: options.machineId,
                    recipientId: recipientId ?? '*',
                    channel,
                    streamId,
                    keyVersion: options.hostedE2ee!.keyVersion,
                }),
                seq: hosted === undefined ? seq : v2EnvelopeSequence(payload),
                at: Date.now(),
            },
            payload,
        };
        socket.send(JSON.stringify(envelope));
    }

    function flush(): void {
        if (socket?.readyState !== WebSocket.OPEN) return;
        const queued = outbound.splice(0);
        for (const item of queued) {
            try { transmit(item.frame, item.sessionId, item.channel, item.recipientId); }
            catch (error) {
                if (item.recipientId === undefined) throw error;
                // A revoked directed recipient no longer has an egress key.
            }
        }
    }

    async function open(): Promise<void> {
        if (closed) return;
        options.onStateChange?.('connecting');
        let url: string;
        try {
            const admission = reconnectMachine({
                ...(options.token === undefined ? {} : { token: options.token }),
            });
            if (admission.admission === 'loopback') {
                url = loopbackMachineSocketUrl(options.relayUrl, options.machineId, admission.token);
            } else {
                url = ticketSocketUrl(options.relayUrl, await issueWsTicket({
                    relayUrl: options.relayUrl,
                    credential: admission.credential,
                    machineId: options.machineId,
                    role: 'machine',
                    transport: 'relay',
                }), 'relay');
            }
        } catch (error) {
            const code = ticketStateCode(error);
            options.onStateChange?.('closed', code);
            if (error instanceof WsTicketError && (error.status === 401 || error.status === 403)) {
                closed = true;
                if (!permanentAuthReported) {
                    permanentAuthReported = true;
                    process.stderr.write(`relay link authentication failed (${code}); run muxr doctor\n`);
                }
                return;
            }
            if (!closed) setTimeout(() => void open(), retryDelay());
            return;
        }
        // Local development retains the larger ceiling; hosted relay config enforces 4 MiB.
        const next = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
        socket = next;

        next.on('open', () => {
            reconnectAttempt = 0;
            options.onStateChange?.('open');
            flush();
        });

        next.on('message', (raw) => {
            let envelope: Envelope;
            try {
                const parsed = JSON.parse(String(raw)) as unknown;
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
                    || !('header' in parsed) || typeof parsed.header !== 'object' || parsed.header === null || Array.isArray(parsed.header)) {
                    throw new Error('malformed envelope');
                }
                envelope = parsed as Envelope;
            } catch {
                options.onClientReject?.('malformed', 'unknown', 'malformed');
                return;
            }
            const senderId = envelope.header.senderId;
            const clientKind: DiagnosticClientKind = hosted === undefined
                ? 'local'
                : senderId === undefined ? 'unknown' : options.hostedE2ee?.deviceKinds?.[senderId] ?? 'unknown';
            const peerIngress = clientKind === 'peer';
            if (peerIngress) options.onPeerIngress?.('received');
            let plaintext: string;
            try {
                if (envelope.header.machineId !== options.machineId) throw new Error('routing mismatch');
                plaintext = hosted === undefined
                    ? envelope.payload
                    : (() => {
                        const stream = envelope.header.streamId;
                        const channel = envelope.header.channel;
                        if (senderId === undefined || envelope.header.recipientId !== options.machineId
                            || (channel !== 'session' && channel !== 'attachment') || stream === undefined
                            || envelope.header.keyVersion !== options.hostedE2ee?.keyVersion
                            || envelope.header.seq !== v2EnvelopeSequence(envelope.payload)) {
                            throw new Error('routing context mismatch');
                        }
                        return hosted.open(senderId, channel, stream, envelope.payload);
                    })();
            } catch {
                if (peerIngress) options.onPeerIngress?.('decrypt-rejected');
                options.onClientReject?.(senderId ?? 'unknown', clientKind, hosted === undefined ? 'malformed' : 'decrypt-rejected');
                return;
            }
            try {
                const frame = parseClientFrame(decodePayload(plaintext));
                if (hosted !== undefined && envelope.header.channel !== (frame.type === 'attachment.read' ? 'attachment' : 'session')) {
                    options.onClientReject?.(senderId ?? 'unknown', clientKind, 'decrypt-rejected');
                    return;
                }
                if (peerIngress) options.onPeerIngress?.('decoded');
                options.onClientFrame(frame, hosted === undefined ? undefined : senderId);
            } catch {
                if (peerIngress) options.onPeerIngress?.('decrypt-rejected');
                options.onClientReject?.(senderId ?? 'unknown', clientKind, 'malformed');
            }
        });

        const retry = (code: number): void => {
            // The relay retires this host when a newer one takes the machineId.
            // Reconnecting would just evict the newer host back.
            const stateCode = closeStateCode(code);
            if (code === RELAY_CLOSE_REPLACED) {
                closed = true;
                options.onStateChange?.('replaced', stateCode);
                return;
            }
            options.onStateChange?.('closed', stateCode);
            if (closed) return;
            setTimeout(() => void open(), retryDelay());
        };
        next.on('close', retry);
        next.on('error', () => next.close());
    }

    void open();

    return {
        send(frame, sessionId, channel = 'session', recipientId) {
            if (socket?.readyState === WebSocket.OPEN) {
                try { transmit(frame, sessionId, channel, recipientId); }
                catch (error) {
                    if (recipientId === undefined) throw error;
                    // A revoked directed recipient no longer has an egress key.
                }
                return;
            }
            if (closed) return;
            if (outbound.length >= MAX_OUTBOUND) outbound.shift();
            outbound.push({ frame, channel, ...(sessionId === undefined ? {} : { sessionId }), ...(recipientId === undefined ? {} : { recipientId }) });
        },
        close() {
            closed = true;
            outbound.length = 0;
            socket?.close();
        },
    };
}
