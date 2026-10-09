/**
 * Live terminal, device half.
 *
 * Open a byokit link stream to attach the pane. Frames are herdr's own NDJSON protocol --
 * base64 ANSI in, keystrokes out -- and are never parsed here.
 *
 * Reconnect: a dropped link stream, including one the host ends, re-attaches with
 * backoff for as long as the pane is open. The pane closes only when the person
 * has to act: another device took it, the device was removed or must pair again,
 * the machine's pairing was lost, or the host kept answering that the agent is
 * gone for 30 s. The pane is never left dead behind a transient relay or host reconnect: the
 * last frame stays on screen while the retry runs, and a machine transport that
 * comes back retries at once instead of waiting out the backoff.
 *
 * Input path: keystrokes that arrive in the same JS task join into one
 * terminal.input frame, and printable keys are echoed locally as dimmed
 * (SGR faint) predictions that herdr's next frame paints over with the real
 * bytes. Predictions are display-only: they ride a separate listener so they
 * never masquerade as host output.
 */

import { newTerminalChannel, nextRequestId } from '@trymuxr/contract';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { storage } from '@/catalog/store';
import type { ByteStreamTransport } from '@/pairing/client';
import { beginTerminalFrameCounts, finalizeTerminalFrameCounts, recordTerminalChannel, recordTerminalFirstFrame, recordTerminalFrameReceived, recordTerminalFrameWritten, type TerminalFrameCountToken } from '@/catalog/diagnostics';
import { getCachedHostedGrant } from '@/pairing/e2ee';

/**
 * 'connecting' until this pane has painted once; 'reconnecting' while a pane
 * that did paint is being re-attached; 'live' while frames flow with nothing
 * known to be wrong; 'unconfirmed' when the link is open but the machine
 * transport last reported a timeout or a lost route, so nobody can say
 * the host is still there until it answers again.
 */
export type TerminalChannelState = 'connecting' | 'live' | 'reconnecting' | 'unconfirmed';

export type TerminalBottomState = 'complete' | 'catching-up' | 'cancelled';

export interface TerminalChannel {
    /** Count a successful native write. Stale after the channel finalizes. */
    recordFrameWritten: () => void;
    /** base64 ANSI chunks from the pane. */
    onData: (listener: (base64: string) => void) => () => void;
    /** Locally predicted echo (dimmed). Display-only: never host output. */
    onPredictedData: (listener: (base64: string) => void) => () => void;
    onClose: (listener: (reason: string) => void) => () => void;
    /**
     * Where herdr's viewport sits in this pane, as herdr reports it. Nothing
     * else can be trusted for that: a scroll the phone sent may have moved
     * herdr's scrollback, been handed to a full-screen program as a wheel
     * report, or done nothing at all, and only the host can tell which.
     */
    onScrollState: (listener: (state: { offsetFromBottom: number; maxOffsetFromBottom: number }) => void) => () => void;
    /** Pane state; 'unconfirmed' while the host is silent — see TerminalChannelState. */
    onState: (listener: (state: TerminalChannelState) => void) => () => void;
    bottom: () => void;
    onBottomState: (listener: (state: TerminalBottomState) => void) => () => void;
    sendText: (text: string) => void;
    sendBytes: (base64: string) => void;
    resize: (cols: number, rows: number) => void;
    /** Scroll the real pane. Positive lines go back (up), negative go forward. */
    scroll: (lines: number, at: { column: number; row: number }) => void;
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

// A transport-level loss is always retryable: the host is still there and the
// pane is still this device's. Backoff is capped so a long outage does not spin,
// and it is reset the moment the machine transport reconnects. Retries stop only
// when the user closes the pane or the host closes the stream.
const RETRY_BASE_MS = 1_500;
const RETRY_MAX_MS = 10_000;
const STABLE_MS = 30_000;

/** The host refused the pane for a reason only the person can change, so it
 *  surfaces in their words instead of looping behind 'reconnecting'. Every
 *  other attach failure (Herdr busy or restarting, pane not ready, a socket
 *  error) is a transient the backoff outlasts. */
class PaneRefusedError extends Error {}

const TAKEN_OVER = 'Open on another device · Tap to use it here';
// ponytail: a plan move or a lagging Herdr snapshot can miss the route for a
// while, so a pane reads as closed on the computer only after the host has
// kept answering "agent unavailable" for this long. Retries go on until then.
const GONE_AFTER_MS = 30_000;
const FINAL_ATTACH_REFUSALS: Record<string, string> = {
    takeover: TAKEN_OVER,
    'device-revoked': 'This device was removed from the computer · Pair again',
    'e2ee-required': 'Pair this device again to open terminals',
};

export async function openTerminal(command: OpenTerminalCommand): Promise<TerminalChannel> {
    let closedByUser = false;
    let closedByHost = false;
    let attachSent = false;
    const assertOpen = (): void => {
        if (closedByUser && !closedByHost || command.signal?.aborted) throw new Error('The terminal was closed.');
    };
    assertOpen();
    const sessionId = command.agentRoute;
    const size = command.size;
    const options = command.mode === undefined ? undefined : { mode: command.mode };
    const settings = getCachedConnectionSettings();
    const grant = getCachedHostedGrant(settings.machineId);
    if (grant === undefined) {
        recordTerminalChannel('attach', { ok: false, code: 'e2ee-required' });
        throw new Error('This device is not paired with this computer. Pair again to open a terminal.');
    }
    if (grant !== undefined && grant.expiresAt <= Date.now()) {
        recordTerminalChannel('attach', { ok: false, code: 'grant-expired' });
        throw new Error("This device's access to the computer expired. Pair again to reconnect.");
    }
    const channel = newTerminalChannel();

    // Every re-attach spawns herdr at this size, so it has to track the resizes
    // that followed. Left at the size we opened with, a reconnect after the
    // keyboard or a rotation brings herdr back at the old row count: it paints
    // a screen of one height into a grid of another, which reads as a band of
    // dead space, or as text landing on the wrong rows.
    let current = size;

    const attach = async (takeover: boolean): Promise<void> => {
        try {
            await attachViaLink(takeover);
        } catch (error) {
            recordTerminalChannel('attach', { ok: false, error });
            throw error;
        }
    };

    const dataListeners = new Set<(base64: string) => void>();
    const pendingData: string[] = [];
    const predictedDataListeners = new Set<(base64: string) => void>();
    const closeListeners = new Set<(reason: string) => void>();
    const stateListeners = new Set<(state: TerminalChannelState) => void>();
    const bottomListeners = new Set<(state: TerminalBottomState) => void>();
    let bottomRequestId: string | undefined;
    const publishBottomState = (state: TerminalBottomState): void => {
        for (const listener of bottomListeners) listener(state);
    };
    const cancelBottom = (): void => {
        if (bottomRequestId === undefined) return;
        bottomRequestId = undefined;
        publishBottomState('cancelled');
    };
    const scrollStateListeners = new Set<(state: { offsetFromBottom: number; maxOffsetFromBottom: number }) => void>();
    // Until the host has answered for this pane, nothing is known about its
    // scrollback -- which is not the same as knowing it has none.
    let lastScrollState: { offsetFromBottom: number; maxOffsetFromBottom: number } | undefined;
    const outbox: string[] = [];
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
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelStableTimer = (): void => {
        if (stableTimer === undefined) return;
        clearTimeout(stableTimer);
        stableTimer = undefined;
    };
    let attachInFlight: Promise<void> | undefined;
    let attachRequested = false;
    let takeoverRequested = false;
    let goneSince: number | undefined;

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
            const lost = machineLost();
            if (lost !== undefined) {
                surfaceHostRefusal(lost);
                return;
            }
            if (current.socketStatus === previous.socketStatus) return;
            if (current.socketStatus === 'connected') {
                hostAnswered();
                resubscribeNow();
            } else if (current.socketStatus !== 'connecting') {
                hostUnconfirmed = true;
                publishState();
            }
        });
    }
    /** A machine client that only pairing or an update can bring back, in its
     *  own words: the pane says so instead of retrying behind 'Reconnecting…'. */
    function machineLost(): string | undefined {
        const { socketStatus, socketError } = storage.getState();
        return socketStatus === 'error' && socketError ? socketError : undefined;
    }
    function unwatchHost(): void {
        stopWatchingHost?.();
        stopWatchingHost = undefined;
    }
    watchHost();

    type QueuedInput = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: Uint8Array };
    let queuedInput: QueuedInput | undefined;
    let inputFlushScheduled = false;

    // ---- Link stream frame routing. ----

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
        // Only the user's visible retry action may take control back once the
        // pane has painted; automatic reconnects never do (see scheduleRetry).
        if (reason === 'control moved to another device') {
            surfaceHostRefusal(TAKEN_OVER);
            return;
        }
        // Anything else -- Herdr restarting under the stream, a plan move that
        // replaced the pane under its route -- re-resolves the route like a
        // lost stream. A pane that is really gone leaves through the tree.
        if (linkWire !== undefined) retireLink(linkWire);
        scheduleRetry();
    };
    function scheduleRetry(): void {
        if (closedByUser || retryTimer !== undefined) return;
        const lost = machineLost();
        if (lost !== undefined) {
            surfaceHostRefusal(lost);
            return;
        }
        cancelStableTimer();
        attempts += 1;
        emitState('reconnecting');
        // Drop queued input: keystrokes buffered across a long disconnect are
        // stale the moment the user sees the dead screen.
        outbox.length = 0;
        queuedInput = undefined;
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            // Until the pane has painted, a retry is still the person's open and
            // takes the pane over; after the first frame, retries never do.
            requestAttach(!painted);
        }, Math.min(RETRY_BASE_MS * attempts, RETRY_MAX_MS));
    }

    /** A refusal the host itself gave: stop retrying and report it, so the pane
     *  offers the person the one action that helps instead of a spinning chip. */
    function surfaceHostRefusal(message: string): void {
        if (closedByUser) return;
        cancelBottom();
        closedByTakeover = message === TAKEN_OVER;
        closedByHost = true;
        lastCloseReason = message;
        closedByUser = true;
        finalizeCounts();
        recordTerminalChannel('disconnected', { ok: false, code: closedByTakeover ? 'takeover' : 'disconnected' });
        unwatchHost();
        for (const listener of closeListeners) listener(message);
    }

    /** Collapse focus, foreground and transport retries into one attach owner. */
    function requestAttach(takeover = false): void {
        if (closedByUser) return;
        attachRequested = true;
        takeoverRequested ||= takeover;
        if (attachInFlight !== undefined) return;

        const pending = (async () => {
            while (attachRequested && !closedByUser) {
                attachRequested = false;
                const takeover = takeoverRequested;
                takeoverRequested = false;
                await attach(takeover);
            }
        })();
        attachInFlight = pending;
        void pending
            .catch((error: unknown) => {
                if (error instanceof PaneRefusedError) surfaceHostRefusal(error.message);
                else scheduleRetry();
            })
            .finally(() => {
                if (attachInFlight === pending) attachInFlight = undefined;
                if (attachRequested && !closedByUser) requestAttach(takeoverRequested);
            });
    }

    const reconnectNow = (explicitTakeover = false): void => {
        let retaking = false;
        if (closedByUser) {
            if (!explicitTakeover || !closedByHost) return;
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
        if (retaking && linkWire !== undefined) retireLink(linkWire);
        if (attachInFlight !== undefined) {
            if (explicitTakeover) requestAttach(true);
            return;
        }
        if (linkWire !== undefined) return; // the pane is live on the link
        attempts = 0;
        emitState('reconnecting');
        requestAttach(explicitTakeover);
    };

    /** The machine transport is back: re-attach the pane at once and drop the
     *  backoff, so a relay/host reconnect resubscribes instead of waiting out
     *  the timer. */
    function resubscribeNow(): void {
        if (closedByUser) return;
        attempts = 0;
        goneSince = undefined;
        // An attach already on its way is this resubscribe.
        if (attachInFlight !== undefined) return;
        // A relay drop ends every stream on that link; one still registered is dead.
        if (linkWire !== undefined) retireLink(linkWire);
        if (retryTimer !== undefined) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        emitState('reconnecting');
        requestAttach(!painted);
    }

    // The pane's stream open IS the attach; the first host frame acknowledges it.
    // A dropped link reattaches the pane through a new stream.
    let linkWire: ByteStreamTransport | undefined;
    type LinkAttachAck = { ok: true } | { ok: false; error?: string; code?: string; streamLost?: boolean };
    let linkAck: ((ack: LinkAttachAck) => void) | undefined;
    let linkAckTransport: ByteStreamTransport | undefined;

    /** Retire a transport without touching the reconnect machinery (replacement, close, failed attach). */
    const retireLink = (transport: ByteStreamTransport): void => {
        if (linkWire === transport) {
            cancelBottom();
            linkWire = undefined;
        }
        if (linkAckTransport === transport) linkAck?.({ ok: false, code: 'socket-error', streamLost: true });
        transport.close();
    };

    async function attachViaLink(takeover: boolean): Promise<void> {
        cancelStableTimer();
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
        if (offer === undefined) {
            goneSince = undefined;
            throw new Error('The connection to the computer is not ready yet.');
        }
        const started = Date.now();
        const transport = await offer.catch(() => undefined);
        if (transport === undefined) {
            goneSince = undefined;
            throw new Error('The computer is not ready to open this pane yet.');
        }
        if (closedByUser || command.signal?.aborted) {
            transport.close();
            throw new Error('The terminal was closed.');
        }
        attachSent = true;
        if (linkWire !== undefined && linkWire !== transport) retireLink(linkWire);
        linkWire = transport;


        const ackPromise = new Promise<LinkAttachAck>((resolve) => {
            const settle = (value: LinkAttachAck): void => {
                clearTimeout(timer);
                if (linkAck === settle) {
                    linkAck = undefined;
                    linkAckTransport = undefined;
                }
                resolve(value);
            };
            linkAck = settle;
            linkAckTransport = transport;
            const timer = setTimeout(() => settle({ ok: false, code: 'socket-timeout', streamLost: true }), 15_000);
        });
        let firstFrameOfStream = false;
        let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
        const beforeAck: object[] = [];
        let beforeAckSize = 0;
        const deliverLinkFrame = (frame: object): void => {
            const type = (frame as { type?: unknown }).type;
            const record = frame as { bytes?: unknown; full?: unknown; width?: unknown; height?: unknown };
            if (type === 'terminal.frame' && typeof record.bytes === 'string') {
                const bytes = record.bytes;
                // A diff Herdr drew for the grid before a resize lands on cells
                // the phone has already reflowed. The full frame every resize
                // brings back repaints them; until then, skip the stale diffs.
                if (record.full !== true && typeof record.width === 'number' && typeof record.height === 'number'
                    && (record.width !== current.cols || record.height !== current.rows)) return;
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
                    stableTimer = setTimeout(() => {
                        stableTimer = undefined;
                        attempts = 0;
                    }, STABLE_MS);
                    emitState('live');
                    recordTerminalFirstFrame(Date.now() - started);
                }
                deliverFrameBytes(bytes);
            } else if (type === 'terminal.bottom-state') {
                const result = frame as { state?: unknown; requestId?: unknown };
                if (bottomRequestId === undefined || result.requestId !== bottomRequestId) return;
                if (result.state === 'complete' || result.state === 'catching-up') {
                    if (result.state === 'complete') bottomRequestId = undefined;
                    publishBottomState(result.state);
                }
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
                    frame = JSON.parse(line);
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
                cancelBottom();
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
            goneSince = ack.code === 'agent-unavailable' ? (goneSince ?? Date.now()) : undefined;
            let refusal = ack.streamLost || ack.code === undefined ? undefined : FINAL_ATTACH_REFUSALS[ack.code];
            if (goneSince !== undefined && Date.now() - goneSince >= GONE_AFTER_MS) refusal = 'This pane was closed on the computer';
            // A tap queued meanwhile (Tap to use it here) gets its own attempt.
            if (refusal !== undefined && !attachRequested) throw new PaneRefusedError(refusal);
            if (!closedByUser && !attachRequested) scheduleRetry();
            return;
        }
        goneSince = undefined;
        recordTerminalChannel('attach', { ok: true });
        return;
    }

    function close(): void {
        cancelBottom();
        closedByUser = true;
        closedByTakeover = false;
        unwatchHost();
        command.signal?.removeEventListener('abort', close);
        finalizeCounts();
        attachRequested = false;
        takeoverRequested = false;
        cancelStableTimer();
        if (retryTimer !== undefined) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        if (attachSent) {
            attachSent = false;
            void sync.request('terminal.detach', { sessionId, channel }).catch(() => {});
        }
        const wire = linkWire;
        if (wire !== undefined) retireLink(wire);
    }

    command.signal?.addEventListener('abort', close, { once: true });
    try {
        assertOpen();
        await attach(true);
        assertOpen();
    } catch (error) {
        if (closedByUser || command.signal?.aborted || error instanceof PaneRefusedError) {
            close();
            throw error;
        }
        // A restored route can attach before the machine link is ready.
        // Keep the channel alive and use the same backoff as a dropped stream.
        scheduleRetry();
    }

    const send = (frame: Record<string, unknown>): void => {
        if (frame.type !== 'terminal.bottom') cancelBottom();
        // A resize/scroll/close must not overtake keystrokes already waiting
        // in the microbatch.
        if (frame.type !== 'terminal.input') flushInput();
        const line = JSON.stringify(frame);
        if (linkWire !== undefined) void linkWire.write(line).catch(() => undefined);
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
        cancelBottom();
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
            if (closedByHost && lastCloseReason !== undefined) listener(lastCloseReason);
            return () => closeListeners.delete(listener);
        },
        bottom: () => {
            flushInput();
            bottomRequestId = nextRequestId('bottom');
            publishBottomState('catching-up');
            send({ type: 'terminal.bottom', requestId: bottomRequestId });
        },
        onBottomState: (listener) => {
            bottomListeners.add(listener);
            return () => bottomListeners.delete(listener);
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
        // Herdr answers every resize, even to the size it has, with a full
        // frame, and the pane stays locked to this phone throughout.
        resize: (cols, rows) => {
            current = { cols, rows };
            send({ type: 'terminal.resize', cols, rows });
        },
        repaint: () => {
            cancelBottom();
            // A resize already brings a full frame back (see `resize`); this is
            // for a screen that disagrees with Herdr's at the same size, such as
            // a failed write. Re-attaching costs the agent a brief redraw at the
            // desk's width: Herdr hands the pane back before it re-locks it.
            if (closedByUser) return;
            if (retryTimer !== undefined) {
                clearTimeout(retryTimer);
                retryTimer = undefined;
            }
            // The live stream stays until its successor exists (attachViaLink
            // retires it then). Retired first, it released the phone's size,
            // Herdr handed the pane back to the desk's wider grid, and whatever
            // the agent drew in that gap was laid out too wide for the phone.
            emitState('reconnecting');
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
                column: Math.max(0, Math.trunc(at.column)),
                row: Math.max(0, Math.trunc(at.row)),
            });
        },
        recordFrameWritten: () => {
            if (frameCounts !== undefined) recordTerminalFrameWritten(frameCounts);
        },
        close,
    };
}
