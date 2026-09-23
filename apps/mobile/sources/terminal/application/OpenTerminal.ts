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

import { issueWsTicket, newTerminalChannel, ticketSocketUrl, type Envelope } from '@muxr/contract';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { channelRelayUrl, getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { storage } from '@/catalog/store';
import { beginTerminalFrameCounts, finalizeTerminalFrameCounts, recordTerminalChannel, recordTerminalFirstFrame, recordTerminalFrameReceived, recordTerminalFrameWritten, type TerminalFrameCountToken } from '@/catalog/diagnostics';
import { DeviceV2Crypto, getCachedHostedGrant, refreshHostedGrant } from '@/pairing/e2ee';

/**
 * 'reconnecting' while this pane's socket is being re-attached; 'live' while
 * frames flow with nothing known to be wrong; 'unconfirmed' when the pane's
 * socket is open but the machine transport last reported a timeout or a lost
 * route, so nobody can say the host is still there until it answers again.
 */
export type TerminalChannelState = 'live' | 'reconnecting' | 'unconfirmed';

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
    let attachSent = false;
    const assertOpen = (): void => {
        if (closedByUser || command.signal?.aborted) throw new Error('terminal: open cancelled');
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
    const sendAttachRequest = async (takeover: boolean): Promise<unknown> => {
        assertOpen();
        attachSent = true;
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
    const attachOnce = (takeover: boolean): Promise<unknown> => grant === undefined
        ? sendAttachRequest(takeover)
        : (async () => {
            const latest = await refreshHostedGrant(settings.machineId, grant!.credential, grant!.relayUrl, await channelRelayUrl(grant!.relayUrl, settings.machineId));
            if (latest !== undefined && latest.keyVersion >= grant!.keyVersion) {
                if (latest.expiresAt <= Date.now()) throw new Error('terminal: device grant expired; pair this browser again');
                grant = latest;
                hosted = new DeviceV2Crypto(latest);
            }
            return sendAttachRequest(takeover);
        })();
    const attach = async (takeover: boolean): Promise<unknown> => {
        try {
            const result = await attachOnce(takeover);
            recordTerminalChannel('attach', { ok: true });
            return result;
        } catch (error) {
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
    let link: 'live' | 'reconnecting' = 'reconnecting';
    let hostUnconfirmed = storage.getState().socketStatus !== 'connected' && storage.getState().socketStatus !== 'connecting';
    let state: TerminalChannelState = 'reconnecting';
    const publishState = (): void => {
        let next: TerminalChannelState = link;
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
            if (!closedByUser) await connectSocket();
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
            closedByTakeover = false;
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
        if (attachInFlight !== undefined) {
            if (explicitTakeover) requestAttach(true);
            return;
        }
        if (socket !== undefined && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
        attempts = 0;
        emitState('reconnecting');
        requestAttach(explicitTakeover);
    };

    async function connectSocket(): Promise<void> {
        if (closedByUser) return;
        // Strict relays reject ticketless sockets. Empty and account-scoped
        // tokens cannot mint a channel ticket, so fail closed instead of
        // opening a 1 Hz unauthorized reconnect loop.
        const ticketInput = relayTicket();
        if (ticketInput === undefined) {
            recordTerminalChannel('attach', { ok: false, code: 'ticket-required' });
            throw new Error('terminal: relay ticket required');
        }
        const relayUrl = await channelRelayUrl(ticketInput.relayUrl, settings.machineId);
        const url = ticketSocketUrl(relayUrl, await issueWsTicket({
            relayUrl,
            credential: ticketInput.credential,
            machineId: settings.machineId,
            role: 'client',
            transport: 'terminal',
            channel,
        }), 'terminal');
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
                        if (retryTimer !== undefined) {
                            clearTimeout(retryTimer);
                            retryTimer = undefined;
                        }
                        clearTimeout(openTimer);
                        attempts = 0;
                        emitState('live');
                        recordTerminalFirstFrame(Date.now() - openStarted);
                    }
                    if (dataListeners.size === 0) pendingData.push(bytes);
                    else for (const listener of dataListeners) listener(bytes);
                } else if (frame.type === 'terminal.scroll-state'
                    && 'offsetFromBottom' in frame && typeof frame.offsetFromBottom === 'number'
                    && 'maxOffsetFromBottom' in frame && typeof frame.maxOffsetFromBottom === 'number') {
                    hostAnswered();
                    lastScrollState = {
                        offsetFromBottom: Math.max(0, Math.trunc(frame.offsetFromBottom)),
                        maxOffsetFromBottom: Math.max(0, Math.trunc(frame.maxOffsetFromBottom)),
                    };
                    for (const listener of scrollStateListeners) listener(lastScrollState);
                } else if (frame.type === 'terminal.closed') {
                    clearTimeout(openTimer);
                    const reason = 'reason' in frame && typeof frame.reason === 'string' ? frame.reason : undefined;
                    // Automatic foreground/reconnect must not steal control back.
                    // Only the user's visible retry action may reverse a takeover.
                    closedByTakeover = reason === 'control moved to another device';
                    closedByUser = true;
                    finalizeCounts();
                    recordTerminalChannel('disconnected', {
                        ok: false,
                        code: closedByTakeover ? 'takeover' : 'disconnected',
                    });
                    unwatchHost();
                    for (const listener of closeListeners) listener(reason);
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
        socket?.close();
    }

    command.signal?.addEventListener('abort', close, { once: true });
    try {
        assertOpen();
        await attach(true);
        assertOpen();
        await connectSocket();
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
            emitState('reconnecting');
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
