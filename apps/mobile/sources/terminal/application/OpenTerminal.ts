/**
 * Live terminal, device half.
 *
 * Ask the host to attach the pane to a channel, then open the client side of
 * that channel. Frames are herdr's own NDJSON protocol --
 * base64 ANSI in, keystrokes out -- and are never parsed here.
 *
 * Reconnect: a dropped channel socket (phone sleep, network switch, relay
 * restart) used to be terminal -- the screen stayed 'disconnected' until
 * re-opened. Now the channel re-attaches itself with backoff and only reports
 * closed when the host says the stream ended or retries run out.
 *
 * Input path: keystrokes that arrive in the same JS task join into one
 * terminal.input frame, and printable keys are echoed locally as dimmed
 * (SGR faint) predictions that herdr's next frame paints over with the real
 * bytes. Predictions are display-only: they ride a separate listener so they
 * never masquerade as host output.
 */

import { issueWsTicket, newTerminalChannel, nextRequestId, ticketSocketUrl, type Envelope } from '@muxr/contract';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { channelRelayUrl, getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { storage } from '@/catalog/store';
import type { TerminalLinkTransport } from '@/pairing/client';
import { beginTerminalFrameCounts, finalizeTerminalFrameCounts, recordTerminalChannel, recordTerminalFirstFrame, recordTerminalFrameReceived, recordTerminalFrameWritten, type TerminalFrameCountToken } from '@/catalog/diagnostics';
import { DeviceV2Crypto, getCachedHostedGrant, refreshHostedGrant } from '@/pairing/e2ee';

/**
 * 'connecting' until this pane has painted once; 'reconnecting' while a pane
 * that did paint is being re-attached; 'live' while frames flow with nothing
 * known to be wrong; 'unconfirmed' when the pane's socket is open but the
 * machine transport last reported a timeout or a lost route, so nobody can say
 * the host is still there until it answers again.
 */
export type TerminalChannelState = 'connecting' | 'live' | 'reconnecting' | 'unconfirmed';

export interface TerminalChannel {
    /** Count a successful native write. Stale after the channel finalizes. */
    recordFrameWritten: () => void;
    /** base64 ANSI chunks from the pane. */
    onData: (listener: (base64: string) => void) => () => void;
    /** Locally predicted echo (dimmed). Display-only: never host output. */
    onPredictedData: (listener: (base64: string) => void) => () => void;
    onClose: (listener: (reason?: string) => void) => () => void;
    /**
     * Where herdr's viewport sits in this pane, as herdr reports it. Nothing
     * else can be trusted for that: a scroll the phone sent may have moved
     * herdr's scrollback, been handed to a full-screen program as a wheel
     * report, or done nothing at all, and only the host can tell which.
     */
    onScrollState: (listener: (state: { offsetFromBottom: number; maxOffsetFromBottom: number }) => void) => () => void;
    /** Pane socket state; 'unconfirmed' while the host is silent — see TerminalChannelState. */
    onState: (listener: (state: TerminalChannelState) => void) => () => void;
    sendText: (text: string) => void;
    sendBytes: (base64: string) => void;
    resize: (cols: number, rows: number) => void;
    /** Scroll the real pane. Positive lines go back (up), negative go forward. */
    scroll: (lines: number, at?: { column: number; row: number }) => void;
    /** Retry now: resets backoff and re-attaches unless the stream is live or closed. */
    /** Pass true only for a user's explicit same-pane takeover action. */
    reconnect: (explicitTakeover?: boolean) => void;
    /** Re-attach a live stream so herdr repaints the whole screen. */
    repaint: () => void;
    close: () => void;
}

export type OpenTerminalCommand = {
    agentRoute: string;
    size: { cols: number; rows: number };
    mode?: 'control' | 'observe';
    signal?: AbortSignal;
};

// ponytail: bounded retries (~2.5 min worst case), then the channel reports
// 'disconnected' like before. Raise the cap if phone-sleep gaps beat it.
const MAX_ATTEMPTS = 15;

export async function openTerminal(command: OpenTerminalCommand): Promise<TerminalChannel> {
    let closedByUser = false;
    let closedByHost = false;
    let attachSent = false;
    const assertOpen = (): void => {
        if (closedByUser && !closedByHost || command.signal?.aborted) throw new Error('terminal: open cancelled');
    };
    assertOpen();
    const sessionId = command.agentRoute;
    const size = command.size;
    const options = command.mode === undefined ? undefined : { mode: command.mode };
    const settings = getCachedConnectionSettings();
    let grant = settings.mode === 'hosted' ? getCachedHostedGrant(settings.machineId) : undefined;
    if (settings.mode === 'hosted' && grant === undefined) {
        recordTerminalChannel('attach', { ok: false, code: 'e2ee-required' });
        throw new Error('terminal: hosted machine grant is missing');
    }
    if (grant !== undefined && grant.expiresAt <= Date.now()) {
        recordTerminalChannel('attach', { ok: false, code: 'grant-expired' });
        throw new Error('terminal: device grant expired; pair this browser again');
    }
    let hosted = grant === undefined ? undefined : new DeviceV2Crypto(grant);
    const channel = newTerminalChannel();

    // Every re-attach spawns herdr at this size, so it has to track the resizes
    // that followed. Left at the size we opened with, a reconnect after the
    // keyboard or a rotation brings herdr back at the old row count: it paints
    // a screen of one height into a grid of another, which reads as a band of
    // dead space, or as text landing on the wrong rows.
    let current = size;

    // The host must be on the channel before the relay will pair a client.
    // The ticket names only the channel, so it is fetched while the host is
    // still attaching instead of one round trip after it. The socket itself
    // still waits for the attach: the relay pairs a client only with a host
    // that is already on the channel.
    let ticketAhead: Promise<string> | undefined;
    const sendAttachRequest = async (takeover: boolean): Promise<unknown> => {
        assertOpen();
        attachSent = true;
        if (ticketAhead === undefined) {
            ticketAhead = socketUrl();
            ticketAhead.catch(() => undefined);
        }
        try {
            return await sync.request('terminal.attach', {
                sessionId,
                channel,
                cols: current.cols,
                rows: current.rows,
                ...(options?.mode === undefined ? {} : { mode: options.mode }),
                ...(grant === undefined ? {} : { deviceId: grant.deviceId, takeover }),
            });
        } finally {
            // A detach during the request can precede host-side registration.
            // Retire again once that request settles, without opening a socket.
            if (closedByUser) {
                attachSent = true;
                close();
            }
        }
    };
    const attachOnce = (takeover: boolean): Promise<unknown> => (async () => {
        // When the link serves the session, the pane's stream open IS the
        // attach; the relay request + channel socket below run only when the
        // link cannot carry the pane.
        if (await attachViaLink(takeover)) return;
        if (grant !== undefined) {
            const latest = await refreshHostedGrant(settings.machineId, grant!.credential, grant!.relayUrl, await channelRelayUrl(grant!.relayUrl, settings.machineId));
            if (latest !== undefined && latest.keyVersion >= grant!.keyVersion) {
                if (latest.expiresAt <= Date.now()) throw new Error('terminal: device grant expired; pair this browser again');
                grant = latest;
                hosted = new DeviceV2Crypto(latest);
            }
        }
        return sendAttachRequest(takeover);
    })();
    const attach = async (takeover: boolean): Promise<unknown> => {
        try {
            const result = await attachOnce(takeover);
            recordTerminalChannel('attach', { ok: true });
            return result;
        } catch (error) {
            // A retry may come after the ticket has expired; it fetches its own.
            ticketAhead = undefined;
            recordTerminalChannel('attach', { ok: false, error });
            throw error;
        }
    };
    const relayTicket = (): { relayUrl: string; credential: string } | undefined => grant !== undefined
        ? { relayUrl: grant.relayUrl, credential: grant.credential }
        : settings.token !== '' && !settings.token.startsWith('acctok_')
            ? { relayUrl: settings.relayUrl, credential: settings.token }
            : undefined;
    // Fail before attach: a ticketless socket is what produced the 1 Hz loop.
    if (relayTicket() === undefined) {
        recordTerminalChannel('attach', { ok: false, code: 'ticket-required' });
        throw new Error('terminal: relay ticket required');
    }

    const dataListeners = new Set<(base64: string) => void>();
    const pendingData: string[] = [];
    const predictedDataListeners = new Set<(base64: string) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    const stateListeners = new Set<(state: TerminalChannelState) => void>();
    const scrollStateListeners = new Set<(state: { offsetFromBottom: number; maxOffsetFromBottom: number }) => void>();
    // Until the host has answered for this pane, nothing is known about its
    // scrollback -- which is not the same as knowing it has none.
    let lastScrollState: { offsetFromBottom: number; maxOffsetFromBottom: number } | undefined;
    const outbox: string[] = [];
    let socket: WebSocket | undefined;
    let frameCounts: TerminalFrameCountToken | undefined;
    let closedByTakeover = false;
    let lastCloseReason: string | undefined;

    const finalizeCounts = (): void => {
        if (frameCounts === undefined) return;
        finalizeTerminalFrameCounts(frameCounts);
        frameCounts = undefined;
    };
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attachInFlight: Promise<void> | undefined;
    let attachRequested = false;
    let takeoverRequested = false;

    // The link is what this channel knows first-hand: attaching, or frames
    // flowing. There is no terminal heartbeat, so the only evidence that an
    // open pane may be talking to nobody comes from the machine transport
    // (storage.socketStatus): 'error' is a request that timed out, 'disconnected'
    // a lost route, 'connected' an authenticated host frame. A known failure
    // reads 'unconfirmed' until this pane paints again or the host answers.
    // Until the pane has painted once there is nothing to re-attach to: a
    // re-attach before the first frame, such as a new pane's grid settling, is
    // still the pane connecting.
    let link: 'live' | 'reconnecting' = 'reconnecting';
    let painted = false;
    let hostUnconfirmed = storage.getState().socketStatus !== 'connected' && storage.getState().socketStatus !== 'connecting';
    let state: TerminalChannelState = 'connecting';
    const publishState = (): void => {
        let next: TerminalChannelState = link === 'reconnecting' && !painted ? 'connecting' : link;
        if (link === 'live' && hostUnconfirmed) next = 'unconfirmed';
        if (state === next) return;
        state = next;
        for (const listener of stateListeners) listener(state);
    };
    const emitState = (nextLink: 'live' | 'reconnecting'): void => {
        if (link !== nextLink) {
            link = nextLink;
            recordTerminalChannel(link, { ok: true });
        }
        publishState();
    };
    const hostAnswered = (): void => {
        if (!hostUnconfirmed) return;
        hostUnconfirmed = false;
        publishState();
    };
    let stopWatchingHost: (() => void) | undefined;
    function watchHost(): void {
        if (stopWatchingHost !== undefined) return;
        hostUnconfirmed = storage.getState().socketStatus !== 'connected' && storage.getState().socketStatus !== 'connecting';
        stopWatchingHost = storage.subscribe((current, previous) => {
            if (current.socketStatus === previous.socketStatus) return;
            if (current.socketStatus === 'connected') hostAnswered();
            else if (current.socketStatus !== 'connecting') {
                hostUnconfirmed = true;
                publishState();
            }
        });
    }
    function unwatchHost(): void {
        stopWatchingHost?.();
        stopWatchingHost = undefined;
    }
    watchHost();

    type QueuedInput = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: Uint8Array };
    let queuedInput: QueuedInput | undefined;
    let inputFlushScheduled = false;

    // ---- Frame routing shared by the relay channel and the link stream. ----

    const deliverFrameBytes = (bytes: string): void => {
        if (dataListeners.size === 0) pendingData.push(bytes);
        else for (const listener of dataListeners) listener(bytes);
    };
    const applyScrollStateFrame = (frame: object): void => {
        const state = frame as { offsetFromBottom?: unknown; maxOffsetFromBottom?: unknown };
        if (typeof state.offsetFromBottom !== 'number' || !Number.isFinite(state.offsetFromBottom)
            || typeof state.maxOffsetFromBottom !== 'number' || !Number.isFinite(state.maxOffsetFromBottom)) return;
        hostAnswered();
        lastScrollState = {
            offsetFromBottom: Math.max(0, Math.trunc(state.offsetFromBottom)),
            maxOffsetFromBottom: Math.max(0, Math.trunc(state.maxOffsetFromBottom)),
        };
        for (const listener of scrollStateListeners) listener(lastScrollState);
    };
    const applyClosedFrame = (frame: object): void => {
        const reason = typeof (frame as { reason?: unknown }).reason === 'string' ? (frame as { reason: string }).reason : undefined;
        // Automatic foreground/reconnect must not steal control back.
        // Only the user's visible retry action may reverse a takeover.
        closedByTakeover = reason === 'control moved to another device';
        closedByHost = true;
        lastCloseReason = reason;
        closedByUser = true;
        finalizeCounts();
        recordTerminalChannel('disconnected', {
            ok: false,
            code: closedByTakeover ? 'takeover' : 'disconnected',
        });
        unwatchHost();
        for (const listener of closeListeners) listener(reason);
    };
    const unwrapHosted = async (plaintext: string): Promise<string> => {
        if (hosted === undefined) return plaintext;
        const envelope = JSON.parse(plaintext) as Envelope;
        if (envelope.header.machineId !== settings.machineId
            || envelope.header.senderId !== settings.machineId
            || envelope.header.recipientId !== '*'
            || envelope.header.channel !== 'terminal'
            || envelope.header.streamId !== channel
            || envelope.header.keyVersion !== grant?.keyVersion) {
            throw new Error('terminal: invalid hosted routing context');
        }
        return hosted.open('terminal', channel, envelope.payload, envelope.header.seq);
    };

    function scheduleRetry(): void {
        if (closedByUser || retryTimer !== undefined) return;
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
            recordTerminalChannel('disconnected', { ok: false, code: 'disconnected' });
            unwatchHost();
            for (const listener of closeListeners) listener('disconnected');
            return;
        }
        emitState('reconnecting');
        // Drop queued input: keystrokes buffered across a long disconnect are
        // stale the moment the user sees the dead screen.
        outbox.length = 0;
        queuedInput = undefined;
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            requestAttach(false);
        }, Math.min(1500 * attempts, 10_000));
    }

    /** Collapse focus, foreground and transport retries into one attach owner. */
    function requestAttach(takeover = false): void {
        if (closedByUser) return;
        attachRequested = true;
        takeoverRequested ||= takeover;
        if (attachInFlight !== undefined) return;

        const pending = (async () => {
            // A resize that lands while attach is waiting must replace that
            // not-yet-paired stream before any client socket is opened.
            while (attachRequested && !closedByUser) {
                attachRequested = false;
                const takeover = takeoverRequested;
                takeoverRequested = false;
                await attach(takeover);
            }
            if (!closedByUser && linkWire === undefined) await connectSocket();
        })();
        attachInFlight = pending;
        void pending
            .catch(scheduleRetry)
            .finally(() => {
                if (attachInFlight === pending) attachInFlight = undefined;
                if (attachRequested && !closedByUser) requestAttach(takeoverRequested);
            });
    }

    const reconnectNow = (explicitTakeover = false): void => {
        let retaking = false;
        if (closedByUser) {
            if (!explicitTakeover || !closedByTakeover) return;
            closedByUser = false;
            closedByHost = false;
            closedByTakeover = false;
            lastCloseReason = undefined;
            retaking = true;
        }
        watchHost();
        if (retryTimer !== undefined) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        if (retaking && socket !== undefined) {
            const stale = socket;
            socket = undefined;
            stale.close();
        }
        if (retaking && linkWire !== undefined) retireLink(linkWire);
        if (attachInFlight !== undefined) {
            if (explicitTakeover) requestAttach(true);
            return;
        }
        if (linkWire !== undefined) return; // the pane is live on the link
        if (socket !== undefined && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
        attempts = 0;
        emitState('reconnecting');
        requestAttach(explicitTakeover);
    };

    async function socketUrl(): Promise<string> {
        // Strict relays reject ticketless sockets. Empty and account-scoped
        // tokens cannot mint a channel ticket, so fail closed instead of
        // opening a 1 Hz unauthorized reconnect loop.
        const ticketInput = relayTicket();
        if (ticketInput === undefined) {
            recordTerminalChannel('attach', { ok: false, code: 'ticket-required' });
            throw new Error('terminal: relay ticket required');
        }
        const relayUrl = await channelRelayUrl(ticketInput.relayUrl, settings.machineId);
        return ticketSocketUrl(relayUrl, await issueWsTicket({
            relayUrl,
            credential: ticketInput.credential,
            machineId: settings.machineId,
            role: 'client',
            transport: 'terminal',
            channel,
        }), 'terminal');
    }
    async function connectSocket(): Promise<void> {
        if (closedByUser) return;
        const ticketed = ticketAhead ?? socketUrl();
        ticketAhead = undefined;
        const url = await ticketed;
        // A repaint/retry may have claimed the attach owner while the ticket
        // request was in flight. Do not let that old ticket open a second
        // channel after the replacement has begun.
        if (closedByUser || socket !== undefined || attachRequested) return;
        const next = new WebSocket(url);
        socket = next;
        let firstFrame = false;
        const openStarted = Date.now();
        // Socket-open proves only relay connectivity. Require the host's first
        // terminal frame, otherwise an orphaned relay can look live forever.
        const openTimer = setTimeout(() => {
            if (socket === next && !closedByUser && !firstFrame) next.close();
        }, 15_000);

        next.onopen = () => {
            if (socket !== next || closedByUser) {
                next.close();
                return;
            }
            recordTerminalChannel('socket-open', { ok: true });
            finalizeCounts();
            frameCounts = beginTerminalFrameCounts();
            for (const line of outbox.splice(0)) next.send(line);
        };
        next.onerror = () => next.close();
        next.onmessage = async (event) => {
            if (socket !== next || closedByUser) return;
            try {
                let plaintext = String(event.data);
                if (hosted !== undefined) {
                    const envelope = JSON.parse(plaintext) as Envelope;
                    if (envelope.header.machineId !== settings.machineId
                        || envelope.header.senderId !== settings.machineId
                        || envelope.header.recipientId !== '*'
                        || envelope.header.channel !== 'terminal'
                        || envelope.header.streamId !== channel
                        || envelope.header.keyVersion !== grant?.keyVersion) {
                        throw new Error('terminal: invalid hosted routing context');
                    }
                    plaintext = await hosted.open('terminal', channel, envelope.payload, envelope.header.seq);
                }
                // Decryption may settle after repaint/reconnect replaced this socket.
                if (socket !== next || closedByUser) return;
                const frame: unknown = JSON.parse(plaintext);
                if (typeof frame !== 'object' || frame === null || !('type' in frame)) {
                    throw new Error('terminal: invalid host frame');
                }
                if (frame.type === 'terminal.frame' && 'bytes' in frame && typeof frame.bytes === 'string') {
                    const bytes = frame.bytes;
                    if (frameCounts !== undefined) recordTerminalFrameReceived(frameCounts);
                    hostAnswered();
                    if (!firstFrame) {
                        firstFrame = true;
                        painted = true;
                        if (retryTimer !== undefined) {
                            clearTimeout(retryTimer);
                            retryTimer = undefined;
                        }
                        clearTimeout(openTimer);
                        attempts = 0;
                        emitState('live');
                        recordTerminalFirstFrame(Date.now() - openStarted);
                    }
                    deliverFrameBytes(bytes);
                } else if (frame.type === 'terminal.scroll-state') {
                    applyScrollStateFrame(frame);
                } else if (frame.type === 'terminal.closed') {
                    clearTimeout(openTimer);
                    applyClosedFrame(frame);
                }
            } catch {
                // Hosted routing/key mismatches are recoverable only after a
                // fresh grant; close so the normal re-attach path fetches it.
                if (hosted !== undefined) next.close();
            }
        };
        next.onclose = () => {
            clearTimeout(openTimer);
            // A replaced socket can close after its successor is already live.
            // Its cleanup owns only itself and must not schedule over the owner.
            if (socket !== next) return;
            socket = undefined;
            finalizeCounts();
            scheduleRetry();
        };
    }

    // ---- The link path. When the session rides the byokit link (the enrolled
    // path), the pane's stream open IS the attach: the host answers with the
    // same `result` shape a terminal.attach request gets, then herdr's NDJSON
    // frames flow both ways through the stream. A dropped link ends the stream;
    // the ordinary reconnect loop reattaches the pane over the relay or a new
    // stream -- the pane itself is never torn down, and nothing says "removed".
    let linkWire: TerminalLinkTransport | undefined;
    type LinkAttachAck = { ok: true } | { ok: false; error?: string; code?: string; streamLost?: boolean };
    let linkAck: ((ack: LinkAttachAck) => void) | undefined;

    /** Retire a transport without touching the reconnect machinery (replacement, close, failed attach). */
    const retireLink = (transport: TerminalLinkTransport): void => {
        if (linkWire === transport) linkWire = undefined;
        transport.close();
    };

    /** Returns true when the link took the pane; false falls through to the relay for this attempt. */
    async function attachViaLink(takeover: boolean): Promise<boolean> {
        const requestId = nextRequestId('lt');
        const offer = sync.openTerminalLink({
            requestId,
            sessionId,
            channel,
            cols: current.cols,
            rows: current.rows,
            ...(options?.mode === undefined ? {} : { mode: options.mode }),
            takeover,
        });
        if (offer === undefined) return false;
        const started = Date.now();
        const transport = await offer.catch(() => undefined);
        if (transport === undefined) return false; // the link cannot carry streams; the relay can
        if (closedByUser || command.signal?.aborted) {
            transport.close();
            throw new Error('terminal: open cancelled');
        }
        attachSent = true;
        if (linkWire !== undefined && linkWire !== transport) retireLink(linkWire);
        linkWire = transport;

        const ackPromise = new Promise<LinkAttachAck>((resolve) => {
            const settle = (value: LinkAttachAck): void => {
                clearTimeout(timer);
                if (linkAck === settle) linkAck = undefined;
                resolve(value);
            };
            linkAck = settle;
            const timer = setTimeout(() => settle({ ok: false, code: 'socket-timeout', streamLost: true }), 15_000);
        });
        let firstFrameOfStream = false;
        let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
        const beforeAck: object[] = [];
        let beforeAckSize = 0;
        const deliverLinkFrame = (frame: object): void => {
            const type = (frame as { type?: unknown }).type;
            const record = frame as { bytes?: unknown };
            if (type === 'terminal.frame' && typeof record.bytes === 'string') {
                const bytes = record.bytes;
                if (frameCounts !== undefined) recordTerminalFrameReceived(frameCounts);
                hostAnswered();
                if (!firstFrameOfStream) {
                    firstFrameOfStream = true;
                    if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer);
                    painted = true;
                    if (retryTimer !== undefined) {
                        clearTimeout(retryTimer);
                        retryTimer = undefined;
                    }
                    attempts = 0;
                    emitState('live');
                    recordTerminalFirstFrame(Date.now() - started);
                }
                deliverFrameBytes(bytes);
            } else if (type === 'terminal.scroll-state') {
                applyScrollStateFrame(frame);
            } else if (type === 'terminal.closed') {
                if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer);
                applyClosedFrame(frame);
            }
        };
        let received = Promise.resolve();
        transport.onLine((line) => {
            received = received.then(async () => {
                if (linkWire !== transport || closedByUser) return;
                let frame: unknown;
                try {
                    frame = JSON.parse(await unwrapHosted(line));
                } catch {
                    if (linkWire !== transport) return;
                    const attaching = linkAck !== undefined;
                    if (attaching) linkAck?.({ ok: false, code: 'socket-error', streamLost: true });
                    retireLink(transport);
                    if (!attaching) scheduleRetry();
                    return;
                }
                if (linkWire !== transport || closedByUser) return;
                if (typeof frame !== 'object' || frame === null || !('type' in frame)) return;
                const type = (frame as { type?: unknown }).type;
                if (type === 'result') {
                    const result = frame as { requestId?: unknown; ok?: unknown; error?: unknown; code?: unknown };
                    if (result.requestId !== requestId || typeof result.ok !== 'boolean' || linkAck === undefined) return;
                    if (result.ok) {
                        firstFrameTimer = setTimeout(() => {
                            if (linkWire === transport && !firstFrameOfStream) transport.close();
                        }, 15_000);
                        finalizeCounts();
                        frameCounts = beginTerminalFrameCounts();
                        for (const queued of outbox.splice(0)) void transport.write(queued).catch(() => undefined);
                        linkAck?.({ ok: true });
                        for (const queued of beforeAck.splice(0)) {
                            if (closedByUser) break;
                            deliverLinkFrame(queued);
                        }
                    } else {
                        beforeAck.length = 0;
                        linkAck?.({ ok: false, error: typeof result.error === 'string' ? result.error : undefined,
                            code: typeof result.code === 'string' ? result.code : undefined });
                    }
                    return;
                }
                if (linkAck !== undefined) {
                    beforeAckSize += line.length;
                    if (beforeAckSize > 1_048_576) {
                        beforeAck.length = 0;
                        linkAck({ ok: false, code: 'socket-error', streamLost: true });
                        retireLink(transport);
                    } else beforeAck.push(frame);
                    return;
                }
                deliverLinkFrame(frame);
            });
        });
        transport.onEnd(() => {
            void received.then(() => {
                if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer);
                if (linkWire !== transport) return;
                linkWire = undefined;
                if (linkAck !== undefined) {
                    linkAck({ ok: false, code: 'socket-error', streamLost: true });
                    return;
                }
                if (closedByUser) return;
                finalizeCounts();
                emitState('reconnecting');
                scheduleRetry();
            });
        });
        const ack = await ackPromise;
        if (!ack.ok) {
            beforeAck.length = 0;
            recordTerminalChannel('attach', { ok: false, error: ack.error ?? ack.code ?? 'link attach failed' });
            retireLink(transport);
            if (ack.streamLost) return false;
            throw new Error(ack.error ?? 'terminal: link attach failed');
        }
        recordTerminalChannel('attach', { ok: true });
        return true;
    }

    function close(): void {
        closedByUser = true;
        closedByTakeover = false;
        unwatchHost();
        command.signal?.removeEventListener('abort', close);
        finalizeCounts();
        attachRequested = false;
        takeoverRequested = false;
        if (retryTimer !== undefined) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        if (attachSent) {
            attachSent = false;
            void sync.request('terminal.detach', { sessionId, channel }).catch(() => {});
        }
        const wire = linkWire;
        linkWire = undefined;
        wire?.close();
        socket?.close();
    }

    command.signal?.addEventListener('abort', close, { once: true });
    try {
        assertOpen();
        await attach(true);
        assertOpen();
        if (linkWire === undefined) await connectSocket();
        assertOpen();
    } catch (error) {
        close();
        throw error;
    }

    const send = (frame: Record<string, unknown>): void => {
        // A resize/scroll/close must not overtake keystrokes already waiting
        // in the microbatch.
        if (frame.type !== 'terminal.input') flushInput();
        const plaintext = JSON.stringify(frame);
        const sealed = hosted?.seal('terminal', channel, plaintext);
        const line = sealed === undefined ? plaintext : JSON.stringify({
            header: {
                machineId: settings.machineId,
                senderId: grant!.deviceId,
                recipientId: settings.machineId,
                channel: 'terminal',
                streamId: channel,
                keyVersion: grant!.keyVersion,
                seq: sealed.sequence,
                at: Date.now(),
            },
            payload: sealed.payload,
        } satisfies Envelope);
        if (linkWire !== undefined) {
            void linkWire.write(line).catch(() => undefined);
            return;
        }
        if (socket !== undefined && socket.readyState === 1) socket.send(line);
        else outbox.push(line);
    };

    // Keystroke microbatch: keys landing in the same JS task join into one
    // terminal.input frame -- one seal, one envelope, one wire frame instead
    // of N. The queue flushes on a microtask, so an isolated key still goes
    // out before the task ends: nothing waits artificially.
    const flushInput = (): void => {
        inputFlushScheduled = false;
        const item = queuedInput;
        queuedInput = undefined;
        if (item === undefined) return;
        if (item.kind === 'text') send({ type: 'terminal.input', text: item.text });
        else send({ type: 'terminal.input', bytes: encodeBase64(item.bytes) });
    };
    const queueInput = (item: QueuedInput): void => {
        const held = queuedInput;
        if (held === undefined) {
            queuedInput = item;
        } else if (held.kind === 'text' && item.kind === 'text') {
            held.text += item.text;
        } else if (held.kind === 'bytes' && item.kind === 'bytes') {
            const joined = new Uint8Array(held.bytes.length + item.bytes.length);
            joined.set(held.bytes, 0);
            joined.set(item.bytes, held.bytes.length);
            queuedInput = { kind: 'bytes', bytes: joined };
        } else {
            // Mixed kinds keep wire order: flush the old kind first.
            flushInput();
            queuedInput = item;
        }
        if (!inputFlushScheduled) {
            inputFlushScheduled = true;
            queueMicrotask(flushInput);
        }
    };

    // Local echo prediction: paint printable input immediately, dimmed (SGR
    // faint). herdr's next frame redraws those cells with real attributes,
    // which replaces a confirmed prediction for free; a wrong one (password
    // prompt, silent program) stays faint until the program repaints those
    // cells. No active erasure: we own no cursor position, and a backward
    // erase that cannot see line wraps would corrupt real cells.
    // ponytail: character-level only; a line-aware predictor is the upgrade
    // path if silent programs ever make the faint ghosts annoying.
    const encoder = new TextEncoder();
    const predictEcho = (text: string): void => {
        if (closedByUser || state !== 'live') return;
        for (const char of text) {
            const code = char.codePointAt(0)!;
            if (code < 0x20 || code === 0x7f) return;
        }
        const predicted = encodeBase64(encoder.encode(`\x1b[2m${text}\x1b[22m`));
        for (const listener of predictedDataListeners) listener(predicted);
    };

    return {
        onData: (listener) => {
            dataListeners.add(listener);
            for (const frame of pendingData.splice(0)) listener(frame);
            return () => dataListeners.delete(listener);
        },
        onClose: (listener) => {
            closeListeners.add(listener);
            if (closedByHost) listener(lastCloseReason);
            return () => closeListeners.delete(listener);
        },
        onScrollState: (listener) => {
            scrollStateListeners.add(listener);
            if (lastScrollState !== undefined) listener(lastScrollState);
            return () => scrollStateListeners.delete(listener);
        },
        onState: (listener) => {
            stateListeners.add(listener);
            listener(state);
            return () => stateListeners.delete(listener);
        },
        onPredictedData: (listener) => {
            predictedDataListeners.add(listener);
            return () => predictedDataListeners.delete(listener);
        },
        sendText: (text) => {
            predictEcho(text);
            queueInput({ kind: 'text', text });
        },
        reconnect: reconnectNow,
        sendBytes: (base64) => {
            const bytes = decodeBase64(base64);
            predictEcho(new TextDecoder().decode(bytes));
            queueInput({ kind: 'bytes', bytes });
        },
        resize: (cols, rows) => {
            current = { cols, rows };
            send({ type: 'terminal.resize', cols, rows });
        },
        repaint: () => {
            // herdr sends a complete screen only on attach; everything after is
            // a diff against the screen it thinks we hold. So once the two
            // disagree -- a reflow, a font change, a dropped frame -- the cells
            // it believes are already correct are never drawn again, and the
            // stale ones sit there forever. Re-attaching is the only way to ask
            // for the whole screen back.
            if (closedByUser) return;
            if (retryTimer !== undefined) {
                clearTimeout(retryTimer);
                retryTimer = undefined;
            }
            const stale = socket;
            socket = undefined;
            const staleLink = linkWire;
            linkWire = undefined;
            emitState('reconnecting');
            staleLink?.close();
            if (stale !== undefined) {
                stale.close();
            }
            attempts = 0;
            requestAttach(false);
        },
        scroll: (lines, at) => {
            const n = Math.abs(Math.trunc(lines));
            if (n === 0) return; // herdr rejects lines:0
            send({
                type: 'terminal.scroll',
                direction: lines > 0 ? 'up' : 'down',
                lines: n,
                ...(at === undefined ? {} : { ...at, column: Math.max(0, Math.trunc(at.column)), row: Math.max(0, Math.trunc(at.row)) }),
            });
        },
        recordFrameWritten: () => {
            if (frameCounts !== undefined) recordTerminalFrameWritten(frameCounts);
        },
        close,
    };
}
