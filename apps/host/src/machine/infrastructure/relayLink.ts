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
import type { DiagnosticPeerIngressOutcome } from '../../diagnostics/index.js';
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

export interface RelayLinkOptions {
    relayUrl: string;
    machineId: string;
    onClientFrame: (frame: ClientFrame, authenticatedSenderId?: string) => void;
    onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'replaced') => void;
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
            options.onStateChange?.('closed');
            if (error instanceof WsTicketError && (error.status === 401 || error.status === 403)) {
                closed = true;
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
                envelope = JSON.parse(String(raw)) as Envelope;
            } catch {
                return;
            }
            const peerIngress = hosted !== undefined && envelope.header.senderId !== undefined
                && options.hostedE2ee?.deviceKinds?.[envelope.header.senderId] === 'peer';
            if (peerIngress) options.onPeerIngress?.('received');
            try {
                if (envelope.header.machineId !== options.machineId) throw new Error('hosted e2ee: routing machine mismatch');
                const plaintext = hosted === undefined
                    ? envelope.payload
                    : (() => {
                        const sender = envelope.header.senderId;
                        const stream = envelope.header.streamId;
                        const channel = envelope.header.channel;
                        if (sender === undefined || envelope.header.recipientId !== options.machineId
                            || (channel !== 'session' && channel !== 'attachment') || stream === undefined
                            || envelope.header.keyVersion !== options.hostedE2ee?.keyVersion
                            || envelope.header.seq !== v2EnvelopeSequence(envelope.payload)) {
                            throw new Error('hosted e2ee: invalid routing context');
                        }
                        return hosted.open(sender, channel, stream, envelope.payload);
                    })();
                const frame = parseClientFrame(decodePayload(plaintext));
                if (hosted !== undefined && envelope.header.channel !== (frame.type === 'attachment.read' ? 'attachment' : 'session')) {
                    throw new Error('hosted e2ee: request channel mismatch');
                }
                if (peerIngress) options.onPeerIngress?.('decoded');
                options.onClientFrame(frame, hosted === undefined ? undefined : envelope.header.senderId);
            } catch {
                if (peerIngress) options.onPeerIngress?.('decrypt-rejected');
                /* malformed or undecryptable frame; ignore rather than kill the link */
            }
        });

        const retry = (code: number): void => {
            // The relay retires this host when a newer one takes the machineId.
            // Reconnecting would just evict the newer host back.
            if (code === RELAY_CLOSE_REPLACED) {
                closed = true;
                options.onStateChange?.('replaced');
                return;
            }
            options.onStateChange?.('closed');
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
