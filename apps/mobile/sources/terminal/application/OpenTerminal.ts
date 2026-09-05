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
 */

import { issueWsTicket, newTerminalChannel, ticketSocketUrl, type Envelope, type TerminalGraphicsReason, type TerminalGraphicsSurface } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { beginTerminalFrameCounts, finalizeTerminalFrameCounts, recordTerminalChannel, recordTerminalFirstFrame, recordTerminalFrameReceived, recordTerminalFrameWritten, type TerminalFrameCountToken } from '@/catalog/infrastructure/connectionDiagnostics';
import { DeviceV2Crypto, getCachedHostedGrant, refreshHostedGrant } from '@/pairing/e2ee';

export type TerminalChannelState = 'live' | 'reconnecting';

export interface TerminalChannel {
    /** Count a successful native write. Stale after the channel finalizes. */
    recordFrameWritten: () => void;
    /** base64 ANSI chunks from the pane. Graphics frames set the second flag. */
    onData: (listener: (base64: string, graphics?: boolean) => void) => () => void;
    onClose: (listener: (reason?: string) => void) => () => void;
    onGraphics: (listener: (active: boolean, reason?: TerminalGraphicsReason, surface?: TerminalGraphicsSurface) => void) => () => void;
    /** 'reconnecting' while a dropped socket is being re-attached, 'live' after. */
    onState: (listener: (state: TerminalChannelState) => void) => () => void;
    sendText: (text: string) => void;
    sendBytes: (base64: string) => void;
    resize: (cols: number, rows: number, cell?: { width: number; height: number }) => void;
    pointer: (phase: 'down' | 'move' | 'up', x: number, y: number, width: number, height: number) => void;
    /** Scroll the real pane. Positive lines go back (up), negative go forward. */
    scroll: (lines: number, at?: { column: number; row: number }) => void;
    /** Retry now: resets backoff and re-attaches unless the stream is live or closed. */
    /** Pass true only for a user's explicit same-pane takeover action. */
    reconnect: (explicitTakeover?: boolean) => void;
    /** Re-attach a live stream; true also recreates Herdr's graphics client. */
    repaint: (graphicsReset?: boolean) => void;
    close: () => void;
}

export type OpenTerminalCommand = {
    agentRoute: string;
    size: { cols: number; rows: number; cellWidthPx?: number; cellHeightPx?: number };
    mode?: 'control' | 'observe';
};

// ponytail: bounded retries (~2.5 min worst case), then the channel reports
// 'disconnected' like before. Raise the cap if phone-sleep gaps beat it.
const MAX_ATTEMPTS = 15;

export async function openTerminal(command: OpenTerminalCommand): Promise<TerminalChannel> {
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
    const sendAttachRequest = (takeover: boolean, graphicsReset: boolean): Promise<unknown> => sync.request('terminal.attach', {
        sessionId,
        channel,
        cols: current.cols,
        rows: current.rows,
        ...(current.cellWidthPx === undefined ? {} : { cellWidthPx: current.cellWidthPx }),
        ...(current.cellHeightPx === undefined ? {} : { cellHeightPx: current.cellHeightPx }),
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
        ...(grant === undefined ? {} : { deviceId: grant.deviceId, takeover }),
        ...(graphicsReset ? { graphicsReset: true } : {}),
    });
    const attachOnce = (takeover: boolean, graphicsReset: boolean): Promise<unknown> => grant === undefined
        ? sendAttachRequest(takeover, graphicsReset)
        : (async () => {
            const latest = await refreshHostedGrant(settings.machineId, grant!.credential);
            if (latest !== undefined && latest.keyVersion >= grant!.keyVersion) {
                if (latest.expiresAt <= Date.now()) throw new Error('terminal: device grant expired; pair this browser again');
                grant = latest;
                hosted = new DeviceV2Crypto(latest);
            }
            return sendAttachRequest(takeover, graphicsReset);
        })();
    const attach = async (takeover: boolean, graphicsReset: boolean): Promise<unknown> => {
        try {
            const result = await attachOnce(takeover, graphicsReset);
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
    await attach(true, false);

    const dataListeners = new Set<(base64: string, graphics?: boolean) => void>();
    const pendingData: { bytes: string; graphics?: boolean }[] = [];
    const closeListeners = new Set<(reason?: string) => void>();
    const stateListeners = new Set<(state: TerminalChannelState) => void>();
    const graphicsListeners = new Set<(active: boolean, reason?: TerminalGraphicsReason, surface?: TerminalGraphicsSurface) => void>();
    let graphicsActive = false;
    let graphicsReason: TerminalGraphicsReason | undefined;
    let graphicsSurface: TerminalGraphicsSurface | undefined;
    const emitGraphics = (active: boolean, reason?: TerminalGraphicsReason, surface?: TerminalGraphicsSurface): void => {
        const nextReason = active ? undefined : reason;
        const nextSurface = active ? surface ?? graphicsSurface : undefined;
        if (graphicsActive === active && graphicsReason === nextReason && graphicsSurface === nextSurface) return;
        graphicsActive = active;
        graphicsReason = nextReason;
        graphicsSurface = nextSurface;
        for (const listener of graphicsListeners) listener(active, nextReason, nextSurface);
    };
    const outbox: string[] = [];
    let socket: WebSocket | undefined;
    let frameCounts: TerminalFrameCountToken | undefined;
    let closedByUser = false;
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
    let graphicsResetRequested = false;

    let state: TerminalChannelState = 'reconnecting';
    const emitState = (nextState: TerminalChannelState): void => {
        if (state === nextState) return;
        state = nextState;
        recordTerminalChannel(state, { ok: true });
        for (const listener of stateListeners) listener(state);
    };

    function scheduleRetry(): void {
        if (closedByUser || retryTimer !== undefined) return;
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
            recordTerminalChannel('disconnected', { ok: false, code: 'disconnected' });
            for (const listener of closeListeners) listener('disconnected');
            return;
        }
        emitState('reconnecting');
        // Drop queued input: keystrokes buffered across a long disconnect are
        // stale the moment the user sees the dead screen.
        outbox.length = 0;
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            requestAttach(false, false);
        }, Math.min(1500 * attempts, 10_000));
    }

    /** Collapse focus, foreground and transport retries into one attach owner. */
    function requestAttach(takeover = false, graphicsReset = false): void {
        if (closedByUser) return;
        attachRequested = true;
        takeoverRequested ||= takeover;
        graphicsResetRequested ||= graphicsReset;
        if (attachInFlight !== undefined) return;

        const pending = (async () => {
            // A resize that lands while attach is waiting must replace that
            // not-yet-paired stream before any client socket is opened.
            while (attachRequested && !closedByUser) {
                attachRequested = false;
                const takeover = takeoverRequested;
                const resetGraphics = graphicsResetRequested;
                takeoverRequested = false;
                graphicsResetRequested = false;
                await attach(takeover, resetGraphics);
            }
            if (!closedByUser) await connectSocket();
        })();
        attachInFlight = pending;
        void pending
            .catch(scheduleRetry)
            .finally(() => {
                if (attachInFlight === pending) attachInFlight = undefined;
                if (attachRequested && !closedByUser) requestAttach(takeoverRequested, graphicsResetRequested);
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
            if (explicitTakeover) requestAttach(true, false);
            return;
        }
        if (socket !== undefined && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
        attempts = 0;
        emitState('reconnecting');
        requestAttach(explicitTakeover, false);
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
        const url = ticketSocketUrl(ticketInput.relayUrl, await issueWsTicket({
            relayUrl: ticketInput.relayUrl,
            credential: ticketInput.credential,
            machineId: settings.machineId,
            role: 'client',
            transport: 'terminal',
            channel,
        }), 'terminal');
        if (closedByUser || socket !== undefined) return;
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
                    const graphics = 'graphics' in frame && typeof frame.graphics === 'boolean' ? frame.graphics : undefined;
                    const rawReason = 'graphicsReason' in frame ? frame.graphicsReason : undefined;
                    const reason = rawReason === 'retired' || rawReason === 'bridge-closed'
                        ? rawReason
                        : undefined;
                    const rawSurface = 'graphicsSurface' in frame ? frame.graphicsSurface : undefined;
                    const surface = rawSurface === 'full' || rawSurface === 'inline' ? rawSurface : undefined;
                    if (frameCounts !== undefined) recordTerminalFrameReceived(frameCounts);
                    if (!firstFrame) {
                        firstFrame = true;
                        clearTimeout(openTimer);
                        attempts = 0;
                        emitState('live');
                        recordTerminalFirstFrame(Date.now() - openStarted);
                    }
                    if (typeof graphics === 'boolean') emitGraphics(graphics, reason, surface);
                    if (dataListeners.size === 0) pendingData.push(typeof graphics === 'boolean' ? { bytes, graphics } : { bytes });
                    else for (const listener of dataListeners) listener(bytes, graphics);
                } else if (frame.type === 'terminal.closed') {
                    clearTimeout(openTimer);
                    const reason = 'reason' in frame && typeof frame.reason === 'string' ? frame.reason : undefined;
                    emitGraphics(false);
                    // Automatic foreground/reconnect must not steal control back.
                    // Only the user's visible retry action may reverse a takeover.
                    closedByTakeover = reason === 'control moved to another device';
                    closedByUser = true;
                    finalizeCounts();
                    recordTerminalChannel('disconnected', {
                        ok: false,
                        code: closedByTakeover ? 'takeover' : 'disconnected',
                    });
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
            emitGraphics(false);
            scheduleRetry();
        };
    }
    await connectSocket();

    const send = (frame: Record<string, unknown>): void => {
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

    return {
        onData: (listener) => {
            dataListeners.add(listener);
            for (const frame of pendingData.splice(0)) listener(frame.bytes, frame.graphics);
            return () => dataListeners.delete(listener);
        },
        onClose: (listener) => {
            closeListeners.add(listener);
            return () => closeListeners.delete(listener);
        },
        onGraphics: (listener) => {
            graphicsListeners.add(listener);
            listener(graphicsActive, graphicsReason, graphicsSurface);
            return () => graphicsListeners.delete(listener);
        },
        onState: (listener) => {
            stateListeners.add(listener);
            listener(state);
            return () => stateListeners.delete(listener);
        },
        sendText: (text) => send({ type: 'terminal.input', text }),
        reconnect: reconnectNow,
        sendBytes: (base64) => send({ type: 'terminal.input', bytes: base64 }),
        resize: (cols, rows, cell) => {
            current = {
                cols,
                rows,
                ...(cell === undefined ? {} : { cellWidthPx: cell.width, cellHeightPx: cell.height }),
            };
            send({
                type: 'terminal.resize',
                cols,
                rows,
                ...(cell === undefined ? {} : { cellWidthPx: cell.width, cellHeightPx: cell.height }),
            });
        },
        pointer: (phase, x, y, width, height) => send({ type: 'terminal.pointer', phase, x, y, width, height }),
        repaint: (graphicsReset = false) => {
            // herdr sends a complete screen only on attach; everything after is
            // a diff against the screen it thinks we hold. So once the two
            // disagree -- a reflow, a font change, a dropped frame -- the cells
            // it believes are already correct are never drawn again, and the
            // stale ones sit there forever. Re-attaching is the only way to ask
            // for the whole screen back.
            if (closedByUser) return;
            const stale = socket;
            socket = undefined;
            emitState('reconnecting');
            emitGraphics(false);
            if (stale !== undefined) {
                stale.close();
            }
            attempts = 0;
            requestAttach(false, graphicsReset);
        },
        scroll: (lines, at) => {
            const n = Math.abs(Math.trunc(lines));
            if (n === 0) return; // herdr rejects lines:0
            send({
                type: 'terminal.scroll',
                direction: lines > 0 ? 'up' : 'down',
                lines: n,
                ...(at === undefined ? {} : { column: Math.max(0, Math.trunc(at.column)), row: Math.max(0, Math.trunc(at.row)) }),
            });
        },
        recordFrameWritten: () => {
            if (frameCounts !== undefined) recordTerminalFrameWritten(frameCounts);
        },
        close: () => {
            emitGraphics(false);
            closedByUser = true;
            finalizeCounts();
            attachRequested = false;
            takeoverRequested = false;
            graphicsResetRequested = false;
            if (retryTimer !== undefined) {
                clearTimeout(retryTimer);
                retryTimer = undefined;
            }
            void sync.request('terminal.detach', { sessionId, channel }).catch(() => {});
            socket?.close();
        },
    };
}
