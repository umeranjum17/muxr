/**
 * Flow control for scrolling a terminal pane.
 *
 * herdr owns the pane's scrollback and repaints the whole screen for every
 * scroll it accepts, so a fling has to travel as one big jump rather than as
 * forty queued small ones. While one scroll's repaint is on the wire, new drag
 * and fling travel piles into an accumulator instead of the network; when
 * output comes back the held travel goes as a single message.
 *
 * The timeout path is the reason this is its own module. A repaint that never
 * arrives must not wedge the gate: without that release the pane scrolls once
 * and then ignores the finger for the rest of the session, which reads as the
 * app being broken rather than as one lost frame.
 */

/**
 * One scroll message costs herdr one full-screen repaint whatever the line
 * count, so the cap only guards against a runaway accumulator.
 */
export const MAX_SCROLL_LINES = 400;
/** A scroll whose repaint never came back must not gate scrolling forever. */
export const SCROLL_ACK_TIMEOUT_MS = 250;

export interface TerminalScrollGateOptions {
    /** Hand one coalesced scroll to the pane's channel. */
    send: (lines: number) => void;
    /** Travel the gate threw away: clamped overflow, or a new gesture starting. */
    onDiscarded: (lines: number) => void;
    /** Travel that actually went out. */
    onSent: (lines: number) => void;
    /** A scroll whose repaint never arrived inside the budget. */
    onTimedOut: () => void;
    /** Coalesce within a frame. Injected so tests drive frames deterministically. */
    scheduleFrame: (run: () => void) => number;
    cancelFrame: (handle: number) => void;
    ackTimeoutMs?: number;
    maxLines?: number;
}

export interface TerminalScrollGate {
    /** Travel from the surface, already in herdr's direction. */
    queue: (lines: number) => void;
    /** Output came back, so the next scroll may go. */
    release: () => void;
    /** A new touch: whatever the last gesture had queued is not this one's. */
    beginGesture: () => void;
    /** Detach or refocus: drop everything in flight and everything queued. */
    reset: () => void;
}

export function createTerminalScrollGate(options: TerminalScrollGateOptions): TerminalScrollGate {
    const ackTimeoutMs = options.ackTimeoutMs ?? SCROLL_ACK_TIMEOUT_MS;
    const maxLines = options.maxLines ?? MAX_SCROLL_LINES;

    let pending = 0;
    let frame: number | undefined;
    let inFlight = false;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;

    const clearAck = (): void => {
        if (ackTimer !== undefined) clearTimeout(ackTimer);
        ackTimer = undefined;
    };

    const scheduleFlush = (): void => {
        if (frame !== undefined) return;
        frame = options.scheduleFrame(flush);
    };

    /**
     * Latest-wins: whatever piled up since the last send goes as one jump. Each
     * queued round trip behind a fling is felt as rubber-band lag; one bigger
     * jump repaints the same screen once.
     */
    function flush(): void {
        frame = undefined;
        if (inFlight) return;
        const lines = Math.trunc(pending);
        pending = 0;
        if (lines === 0) return;
        // A guard that discards a gesture in silence is how scrolling comes to
        // feel arbitrary. Count what it eats.
        const clamped = Math.max(-maxLines, Math.min(maxLines, lines));
        if (clamped !== lines) options.onDiscarded(Math.abs(lines - clamped));
        options.onSent(Math.abs(clamped));
        inFlight = true;
        ackTimer = setTimeout(timeOut, ackTimeoutMs);
        options.send(clamped);
    }

    function release(): void {
        if (!inFlight) return;
        clearAck();
        inFlight = false;
        if (Math.trunc(pending) !== 0) scheduleFlush();
    }

    /**
     * Nothing came back inside the budget. The gate opens anyway, and the phone
     * records that it happened: a pane that keeps timing out is not keeping up
     * with the finger.
     */
    function timeOut(): void {
        if (!inFlight) return;
        options.onTimedOut();
        release();
    }

    return {
        queue(lines) {
            pending += lines;
            scheduleFlush();
        },
        release,
        beginGesture() {
            if (pending !== 0) options.onDiscarded(Math.abs(pending));
            pending = 0;
        },
        reset() {
            if (frame !== undefined) options.cancelFrame(frame);
            clearAck();
            frame = undefined;
            inFlight = false;
            pending = 0;
        },
    };
}
