/**
 * The machine host's outbound link to the relay.
 *
 * Outbound-only by design: the host opens the connection, so there is no inbound
 * port, no NAT traversal, and no firewall rule on the user's machine.
 */

import WebSocket from 'ws';
import { createPayloadCodec, isEncryptedPayload, v2EnvelopeSequence, type PayloadCodec } from '@muxr/crypto';
import { HostV2Crypto, type HostedMachineKeys } from './hostedE2ee.js';
import {
    decodePayload,
    encodePayload,
    RELAY_CLOSE_REPLACED,
    type ClientFrame,
    type Envelope,
    type HostFrame,
    issueWsTicket,
    ticketSocketUrl,
    WsTicketError,
} from '@muxr/contract';

export interface RelayLinkOptions {
    relayUrl: string;
    machineId: string;
    onClientFrame: (frame: ClientFrame, authenticatedSenderId?: string) => void;
    onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'replaced') => void;
    /** ponytail: fixed backoff. Make it adaptive when a real network says so. */
    reconnectDelayMs?: number;
    /**
     * base64 shared key from @muxr/crypto. When absent, payloads travel in
     * cleartext -- E2EE is explicit opt-in and is never silently assumed.
     */
    sharedKey?: string;
    /** Mandatory strict v2 keys in hosted mode. Mutually exclusive with sharedKey. */
    hostedE2ee?: HostedMachineKeys;
    /**
     * Machine token from POST /v1/machines. Required whenever the relay runs in
     * strict auth, which is every non-loopback deployment.
     */
    token?: string;
}

export interface RelayLink {
    send: (frame: HostFrame, sessionId?: string, channel?: 'session' | 'attachment') => void;
    close: () => void;
}

export function connectToRelay(options: RelayLinkOptions): RelayLink {
    const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    if (options.hostedE2ee !== undefined && options.sharedKey !== undefined) {
        throw new Error('hosted e2ee cannot use the legacy shared key codec');
    }
    const codec: PayloadCodec = createPayloadCodec(options.sharedKey);
    const hosted = options.hostedE2ee === undefined ? undefined : new HostV2Crypto(options.hostedE2ee);
    let socket: WebSocket | undefined;
    let seq = 0;
    let closed = false;
    let reconnectAttempt = 0;
    const retryDelay = (): number => Math.min(reconnectDelayMs * 2 ** reconnectAttempt++, 30_000);
    /**
     * Request ids that arrived CLEARTEXT (the relay's synthetic requests, e.g.
     * attachment downloads and push actions) must be answered in cleartext --
     * the relay has no shared key. Everything else stays encrypted.
     */
    const cleartextRequestIds = new Set<string>();
    /** Frames that arrived while the socket was down. Hello still goes first. */
    const outbound: Array<{ frame: HostFrame; sessionId?: string; channel: 'session' | 'attachment' }> = [];
    const MAX_OUTBOUND = 64;

    function transmit(frame: HostFrame, sessionId: string | undefined, channel: 'session' | 'attachment'): void {
        if (socket?.readyState !== WebSocket.OPEN) return;
        seq += 1;
        const plaintext = encodePayload(frame);
        const streamId = sessionId ?? 'machine';
        // Local-only synthetic requests retain their compatibility response.
        // Hosted mode has no relay-decryptable request path at all.
        const stayCleartext = hosted === undefined && frame.type === 'result' && cleartextRequestIds.delete(frame.requestId);
        const payload = hosted === undefined
            ? (stayCleartext ? plaintext : codec.encode(plaintext))
            : hosted.seal(channel, streamId, plaintext);
        const envelope: Envelope = {
            header: {
                machineId: options.machineId,
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(hosted === undefined ? {} : {
                    senderId: options.machineId,
                    recipientId: '*',
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
        for (const item of queued) transmit(item.frame, item.sessionId, item.channel);
    }

    async function open(): Promise<void> {
        if (closed) return;
        options.onStateChange?.('connecting');
        let url: string;
        try {
            const legacyToken = options.token?.startsWith('machinetok_') === true;
            url = options.token === undefined || legacyToken
                ? `${options.relayUrl}?role=machine&machineId=${encodeURIComponent(options.machineId)}${options.token === undefined ? '' : `&token=${encodeURIComponent(options.token)}`}`
                : ticketSocketUrl(options.relayUrl, await issueWsTicket({
                    relayUrl: options.relayUrl,
                    credential: options.token,
                    machineId: options.machineId,
                    role: 'machine',
                    transport: 'relay',
                }), 'relay');
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
            try {
                if (envelope.header.machineId !== options.machineId) throw new Error('hosted e2ee: routing machine mismatch');
                const plaintext = hosted === undefined
                    ? codec.decode(envelope.payload)
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
                const frame = decodePayload<ClientFrame>(plaintext);
                if (hosted !== undefined && envelope.header.channel !== (frame.type === 'attachment.read' ? 'attachment' : 'session')) {
                    throw new Error('hosted e2ee: request channel mismatch');
                }
                if (hosted === undefined && !isEncryptedPayload(envelope.payload) && 'requestId' in frame && typeof frame.requestId === 'string') {
                    cleartextRequestIds.add(frame.requestId);
                    if (cleartextRequestIds.size > 1000) cleartextRequestIds.clear();
                }
                options.onClientFrame(frame, hosted === undefined ? undefined : envelope.header.senderId);
            } catch {
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
        send(frame, sessionId, channel = 'session') {
            if (socket?.readyState === WebSocket.OPEN) {
                transmit(frame, sessionId, channel);
                return;
            }
            if (closed) return;
            if (outbound.length >= MAX_OUTBOUND) outbound.shift();
            outbound.push(sessionId === undefined ? { frame, channel } : { frame, sessionId, channel });
        },
        close() {
            closed = true;
            outbound.length = 0;
            socket?.close();
        },
    };
}
