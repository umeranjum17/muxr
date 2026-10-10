/**
 * Terminal manager: one HerdrKit terminal session per attached channel, piped
 * to the relay channel socket verbatim.
 *
 * The frames on the socket ARE herdr's own NDJSON terminal protocol -- the only
 * host-generated frame is `terminal.ready`. Control mode is taken with
 * --takeover: the phone is the primary driver, and herdr hands the pane back to
 * the next desk attach.
 */

import type { TerminalSession } from '@byokit/herdr';
import { type TerminalScrollStateFrame } from '@trymuxr/contract';
import { type TerminalPipe } from '../../machine/index.js';

export interface TerminalOpenOptions {
    mode: 'control' | 'observe';
    cols: number;
    rows: number;
}

export interface TerminalManagerOptions {
    resolvePane: (sessionId: string) => Promise<string>;
    focusSession: (sessionId: string, assertActive?: () => void) => Promise<void>;
    /** Herdr's own viewport position for a pane. Omitted, the phone is told nothing. */
    readPaneScroll?: (paneId: string) => Promise<{ offsetFromBottom: number; maxOffsetFromBottom: number }>;
    /** The pane's visible text. Omitted, a program's wheel is turned a row a report. */
    readPaneText?: (paneId: string) => Promise<string>;
    /** Opens the kit terminal session; the kit owns the herdr binary and env. */
    openTerminal: (paneId: string, opts: TerminalOpenOptions) => TerminalSession;
}

interface Attachment {
    channel: string;
    sessionId: string;
    paneId: string;
    mode: 'control' | 'observe';
    deviceId?: string;
    assertAuthorized?: () => void;
    session: TerminalSession;
    socket: TerminalPipe;
    cols: number;
    rows: number;
    initialFrameReceived: boolean;
    scrollStateTimer?: ReturnType<typeof setTimeout>;
    scrollStateReading: boolean;
    scrollStateDirty: boolean;
    scrollOffsetFromBottom: number;
    /** Whether Herdr holds scrollback here, as last read; unknown until then. */
    herdrOwnsScroll?: boolean;
    /** Rows the program on the alternate screen moves per wheel report, once measured. */
    wheelStep?: number;
    /** How long the program took to paint that measured report. */
    wheelPaintMs?: number;
    close: (reason?: string) => void;
}

export type TerminalAttachParams = {
    sessionId: string;
    channel: string;
    cols: number;
    rows: number;
    mode?: 'control' | 'observe';
    deviceId?: string;
    takeover?: boolean;
    /** The already-open byokit link stream. */
    socket: TerminalPipe;
    assertAuthorized?: () => void;
};

const TERMINAL_RELEASE_MS = 250;
// Herdr's terminal client turns an expired handshake read timeout into an I/O
// framing error, printed with the platform's EAGAIN wording. Before a real
// frame that means the transport never came up -- the pane itself is untouched.
const TRANSIENT_TRANSPORT = /resource temporarily unavailable \(os error 11\)|wouldblock/i;
/** A fling's scrolls arrive in a run; only where it stopped is worth reading. */
const SCROLL_STATE_SETTLE_MS = 90;

/**
 * Herdr hands a scroll on a pane with no scrollback of its own to the program
 * as ONE wheel report whatever its line count (measured on 0.9.1), so a whole
 * fling, or a jump to Latest, turned Claude Code's wheel by a single notch.
 * Each row goes as its own report instead, one per tick: reports that reach a
 * program in one write are largely lost (Claude Code moved 40-100 rows for any
 * single burst of 20 to 240). The cap bounds how long a runaway request can
 * keep the wheel turning.
 */
const WHEEL_TICK_MS = 2;
const MAX_WHEEL_ROWS = 10_000;
/**
 * A program may read reports that close in as one fast spin and accelerate
 * them: Claude Code moves one row for each of the first four under 40 ms
 * apart, then up to 6 rows a report, until a gap of 40 ms resets it. So the
 * wheel turns in bursts of four with a rest between them, which keeps a drag
 * or a fling under the finger (about 90 rows a second) in every program.
 * Only a request that far outruns that -- Latest -- turns without resting.
 */
const WHEEL_BURST = 4;
const WHEEL_REST_MS = 45;
const WHEEL_RUSH_ROWS = 100;
/**
 * A program that stops repainting while its wheel turns has reached the end
 * it was turned toward: the rest of the rows owed would only keep a working
 * agent's wheel spinning at its live edge.
 */
const WHEEL_STILL_MS = 500;
/**
 * Programs differ in how far one wheel report moves them: Claude Code one row,
 * OpenCode and vim three. Turned a report per row, those ran three times ahead
 * of the finger. So the first reports on a program's screen go one at a time,
 * reading the screen either side, until two agree on the step.
 */
const WHEEL_MEASURE_TRIES = 6;
const WHEEL_MEASURE_PAINT_MS = 400;
const WHEEL_MEASURE_SETTLE_MS = 60;
const MAX_WHEEL_STEP = 12;
/**
 * A program that keeps repainting never goes still at its live edge, so
 * Latest also stops the wheel now and then and watches: a screen that moves
 * up on its own is following new output, which only happens at the bottom.
 */
const WHEEL_FOLLOW_AFTER_MS = 400;
const WHEEL_FOLLOW_SETTLE_MS = 120;
const WHEEL_FOLLOW_WATCH_MS = 250;

/**
 * How far the lines on a screen moved between two reads: positive when they
 * moved down (the view went back), negative when they moved up, undefined when
 * no shift explains more lines than standing still. Only lines that appear
 * once count, so blank rows and repeated chrome cannot vote.
 */
export function screenShift(before: string, after: string): number | undefined {
    const was = before.split('\n').map((line) => line.trimEnd());
    const now = after.split('\n').map((line) => line.trimEnd());
    const seen = new Map<string, number>();
    for (const line of was) seen.set(line, (seen.get(line) ?? 0) + 1);
    const matches = (shift: number): number => was.filter((line, i) =>
        line.trim() !== '' && seen.get(line) === 1 && now[i + shift] === line).length;
    let best: number | undefined;
    let bestCount = Math.max(2, matches(0));
    for (let step = 1; step <= MAX_WHEEL_STEP; step++) {
        for (const shift of [step, -step]) {
            const count = matches(shift);
            if (count > bestCount) { best = shift; bestCount = count; }
        }
    }
    return best;
}

/** Herdr's initial screen is a full repaint record, not merely the first line. */
function isInitialScreenRecord(line: string): boolean {
    try {
        const record = JSON.parse(line) as { type?: unknown; full?: unknown; bytes?: unknown };
        return record.type === 'terminal.frame' && record.full === true && typeof record.bytes === 'string';
    } catch {
        return false;
    }
}

type ScrollInput = { direction?: unknown; lines?: unknown; column?: unknown; row?: unknown };

function scrollInput(line: string): ScrollInput | undefined {
    try {
        const frame = JSON.parse(line) as ScrollInput & { type?: unknown };
        return frame.type === 'terminal.scroll' ? frame : undefined;
    } catch {
        return undefined;
    }
}

export class TerminalManager {
    private readonly attachments = new Map<string, Attachment>();
    /** Attach and detach for one channel must have one owner at a time. */
    private readonly channelQueues = new Map<string, Promise<void>>();
    private readonly controlQueues = new Map<string, Promise<void>>();
    constructor(private readonly options: TerminalManagerOptions) {}

    async attach(params: TerminalAttachParams): Promise<{ paneId: string }> {
        return this.serializeChannel(params.channel, () => this.attachUnlocked(params));
    }

    private async attachUnlocked(params: TerminalAttachParams): Promise<{ paneId: string }> {
        const paneId = await this.options.resolvePane(params.sessionId);
        if ((params.mode ?? 'control') !== 'control') return this.attachNow(params, paneId);

        // Linearize same-pane control requests. The previous controller stays
        // live until its successor has a relay channel and herdr process.
        const previous = this.controlQueues.get(paneId) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(() => this.attachNow(params, paneId));
        const tail = run.then(() => undefined, () => undefined);
        this.controlQueues.set(paneId, tail);
        try {
            return await run;
        } finally {
            if (this.controlQueues.get(paneId) === tail) this.controlQueues.delete(paneId);
        }
    }

    private async attachNow(params: TerminalAttachParams, paneId: string): Promise<{ paneId: string }> {
        const assertActive = (): void => {
            params.assertAuthorized?.();
            if (!params.socket.isOpen) {
                throw Object.assign(new Error('terminal: link stream ended'), { code: 'socket-error' });
            }
        };
        assertActive();
        const mode = params.mode ?? 'control';
        if (mode === 'control') {
            const controller = [...this.attachments.values()].find((attachment) =>
                attachment.mode === 'control' && attachment.paneId === paneId,
            );
            if (controller !== undefined && controller.deviceId !== params.deviceId && params.takeover !== true) {
                throw Object.assign(new Error('terminal: pane is controlled by another device; explicit takeover required'), { code: 'takeover' });
            }
        }

        // Selecting a control session must select that pane on the desk;
        // observers must never move it.
        // Do this after authority/takeover checks and before opening resources.
        if (mode === 'control') await this.options.focusSession(params.sessionId, assertActive);
        assertActive();

        const socket = params.socket;

        assertActive();
        // Observe renders the pane without touching it: no takeover, no real-PTY
        // resize -- that is what makes the home screen's live preview cards free.
        const observe = mode === 'observe';
        const session = this.options.openTerminal(paneId, { mode, cols: params.cols, rows: params.rows });
        // Tap before the handshake: `ready` fires on the first frame, which
        // would otherwise arrive with nobody subscribed and be lost. Frames
        // queue behind pause() until the pump below starts draining.
        const early: string[] = [];
        const removeEarlyTap = session.onFrame((line) => {
            session.pause();
            early.push(line);
        });
        // The kit rejects `ready` when the spawn fails or the stream ends
        // before its first frame (its tail is the bounded handshake record).
        // Do not acknowledge the attach until Herdr actually starts: otherwise
        // the reason is lost before the phone joins and a permanent PATH fault
        // looks like endless network reconnecting.
        try {
            await session.ready;
        } catch (error) {
            removeEarlyTap();
            try { session.close(); } catch { /* already dead */ }
            socket.close();
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`terminal: could not start herdr terminal session on ${paneId}: ${message}\n`);
            throw Object.assign(new Error(`terminal: could not start Herdr: ${message}`), { code: 'unavailable' });
        }

        try {
            assertActive();
        } catch (error) {
            removeEarlyTap();
            try { session.close(); } catch { /* already dead */ }
            socket.close();
            throw error;
        }

        const attachment: Attachment = {
            channel: params.channel,
            sessionId: params.sessionId,
            paneId,
            mode,
            ...(params.deviceId === undefined ? {} : { deviceId: params.deviceId }),
            ...(params.assertAuthorized === undefined ? {} : { assertAuthorized: params.assertAuthorized }),
            session,
            socket,
            cols: params.cols,
            rows: params.rows,
            initialFrameReceived: false,
            scrollStateReading: false,
            scrollStateDirty: false,
            scrollOffsetFromBottom: 0,
            close: () => undefined,
        };

        let finished = false;
        let bottomGeneration = 0;
        let bottomRunning = false;
        // Rows still owed to a program's wheel, positive toward 'up'.
        let wheelRows = 0;
        let wheelReachedEnd = false;
        let wheelAt: Pick<ScrollInput, 'column' | 'row'> = {};
        let wheelTimer: ReturnType<typeof setTimeout> | undefined;
        let paintedAt = 0;
        let wheelBurst = 0;
        let wheelSentAt = 0;
        let wheelMeasuring = false;
        let wheelMeasureTries = 0;
        let wheelMeasured: number | undefined;
        let childExited = false;
        void session.exited.then(() => { childExited = true; });
        let removeInputRef: () => void = () => undefined;
        let removeFrameRef: () => void = () => undefined;
        const removeInput = (): void => {
            removeInputRef();
            removeFrameRef();
        };
        const finish = (reason?: string): void => {
            if (finished) return;
            finished = true;
            bottomGeneration++;
            removeInput();
            clearTimeout(wheelTimer);
            wheelTimer = undefined;
            wheelRows = 0;
            if (attachment.scrollStateTimer !== undefined) clearTimeout(attachment.scrollStateTimer);
            delete attachment.scrollStateTimer;
            attachment.scrollStateDirty = false;
            if (reason !== undefined && socket.isOpen) {
                if (this.authorized(attachment)) this.sendResult(socket, params.channel, { type: 'terminal.closed', reason });
                socket.close();
            }
            if (this.attachments.get(params.channel) === attachment) this.attachments.delete(params.channel);
        };
        attachment.close = (reason?: string): void => {
            if (finished) return;
            if (reason === undefined) {
                finish();
                socket.close();
            } else {
                finish(reason);
            }
            // Graceful release first so Herdr hands the pane back, then SIGTERM
            // on a timer in case the release never lands.
            try {
                if (!childExited) session.send(JSON.stringify({ type: 'terminal.release' }));
            } catch {
                /* stream already gone */
            }
            if (!childExited) {
                const killTimer = setTimeout(() => {
                    try { session.close(); } catch { /* already dead */ }
                }, TERMINAL_RELEASE_MS);
                killTimer.unref?.();
            }
        };

        // Commit only after the successor is ready. Observe streams are never
        // displaced, and the old controller receives a final reason so its
        // client does not auto-reattach and steal control back.
        const replaced = this.attachments.get(params.channel);
        if (replaced !== undefined) replaced.close();
        if (mode === 'control') {
            for (const current of this.attachments.values()) {
                if (current.mode === 'control' && current.paneId === paneId) {
                    current.close('control moved to another device');
                }
            }
        }
        this.attachments.set(params.channel, attachment);

        const onInputError = (error: Error): void => {
            attachment.close(`herdr stream input failed: ${error.message}`);
        };
        const onInput = (text: string): void => {
            if (finished || this.attachments.get(params.channel) !== attachment || childExited) return;
            if (!this.authorized(attachment)) return;
            if (text.trim().length === 0) return;
            try {
                bottomGeneration++;
                if (bottomRunning) {
                    bottomRunning = false;
                    wheelRows = 0;
                    clearTimeout(wheelTimer);
                    wheelTimer = undefined;
                }
                const input = JSON.parse(text) as { type?: unknown; requestId?: unknown; cols?: number; rows?: number };
                if (input.type === 'terminal.resize' && Number.isInteger(input.cols) && Number.isInteger(input.rows) && input.cols! > 0 && input.rows! > 0) {
                    attachment.cols = input.cols!;
                    attachment.rows = input.rows!;
                }
                if (input.type === 'terminal.bottom') {
                    if (typeof input.requestId !== 'string' || input.requestId.length === 0 || input.requestId.length > 256) return;
                    const requestId = input.requestId;
                    bottomRunning = true;
                    wheelRows = 0;
                    clearTimeout(wheelTimer);
                    wheelTimer = undefined;
                    const generation = bottomGeneration;
                    void goToBottom(generation, requestId).catch(() => {
                        if (!finished && bottomGeneration === generation && this.authorized(attachment)) this.sendResult(socket, params.channel, { type: 'terminal.bottom-state', requestId, state: 'catching-up' });
                    }).finally(() => {
                        if (bottomGeneration === generation) bottomRunning = false;
                    });
                    return;
                }
                const scroll = scrollInput(text);
                const lines = Number(scroll?.lines);
                if (scroll !== undefined && attachment.herdrOwnsScroll === false && (scroll.direction === 'up' || scroll.direction === 'down')
                    && Number.isInteger(lines) && lines > 0) {
                    const rows = scroll.direction === 'up' ? lines : -lines;
                    // A finger that turns back wants the new way now, not
                    // after the rest of the old way is paid off.
                    const owed = Math.sign(wheelRows) === -Math.sign(rows) ? rows : wheelRows + rows;
                    wheelRows = Math.max(-MAX_WHEEL_ROWS, Math.min(MAX_WHEEL_ROWS, owed));
                    wheelAt = { column: scroll.column, row: scroll.row };
                    if (wheelTimer === undefined) {
                        paintedAt = Date.now();
                        turnWheel();
                    }
                } else {
                    // A key goes to the program at its live edge; the rest of a
                    // fling must not carry it back up afterwards.
                    if (scroll === undefined) wheelRows = 0;
                    session.send(text);
                }
                // Whatever a scroll turns out to move -- Herdr's own
                // scrollback, a program's wheel handler, or nothing at all --
                // the phone is told where Herdr's viewport ended up. Without
                // this, a scroll away from the live edge was reported only
                // at the next attach.
                if (scroll !== undefined) this.scheduleScrollState(attachment);
            } catch (error) {
                onInputError(error instanceof Error ? error : new Error(String(error)));
            }
        };
        const wheelStep = (): number => attachment.wheelStep ?? 1;
        const turnWheel = (): void => {
            wheelTimer = undefined;
            if (finished || Math.abs(wheelRows) < wheelStep() || childExited || wheelMeasuring) return;
            if (attachment.wheelStep === undefined && wheelMeasureTries < WHEEL_MEASURE_TRIES && this.options.readPaneText !== undefined) {
                void measureWheel();
                return;
            }
            if (!pumping && Date.now() - paintedAt > WHEEL_STILL_MS) {
                wheelRows = 0;
                wheelReachedEnd = true;
                return;
            }
            const now = Date.now();
            if (now - wheelSentAt >= WHEEL_REST_MS) wheelBurst = 0;
            if (wheelBurst >= WHEEL_BURST && Math.abs(wheelRows) <= WHEEL_RUSH_ROWS * wheelStep()) {
                wheelTimer = setTimeout(turnWheel, WHEEL_REST_MS - (now - wheelSentAt));
                return;
            }
            wheelBurst += 1;
            wheelSentAt = now;
            if (!sendWheel()) return;
            // Rows short of a whole report wait for the finger's next move.
            if (Math.abs(wheelRows) >= wheelStep()) wheelTimer = setTimeout(turnWheel, WHEEL_TICK_MS);
        };
        const sendWheel = (): boolean => {
            const up = wheelRows > 0;
            wheelRows += up ? -wheelStep() : wheelStep();
            try {
                session.send(JSON.stringify({ type: 'terminal.scroll', direction: up ? 'up' : 'down', lines: 1, ...wheelAt }));
                return true;
            } catch (error) {
                onInputError(error instanceof Error ? error : new Error(String(error)));
                return false;
            }
        };
        const measureWheel = async (): Promise<void> => {
            const read = this.options.readPaneText!;
            wheelMeasuring = true;
            wheelMeasureTries++;
            try {
                const before = await read(attachment.paneId);
                if (finished || wheelRows === 0) return;
                const up = wheelRows > 0;
                const direction = up ? 1 : -1;
                const sentAt = Date.now();
                if (!sendWheel()) return;
                // Read until the report shows: a streaming program paints its own
                // frames meanwhile, and a busy host paints the report late.
                let step: number | undefined;
                do {
                    await new Promise((resolve) => setTimeout(resolve, WHEEL_MEASURE_SETTLE_MS));
                    const shift = screenShift(before, await read(attachment.paneId));
                    step = shift === undefined ? undefined : shift * direction;
                } while (!(step !== undefined && step > 0) && !finished && Date.now() - sentAt < WHEEL_MEASURE_PAINT_MS);
                // Output landing while a program follows its live edge skews one
                // reading, never two the same way.
                if (step !== undefined && step > 0 && step === wheelMeasured) {
                    attachment.wheelStep = step;
                    attachment.wheelPaintMs = Date.now() - sentAt;
                    // The report already sent counted as one row; settle the rest.
                    wheelRows = up ? Math.max(0, wheelRows + 1 - step) : Math.min(0, wheelRows + step - 1);
                }
                wheelMeasured = step;
            } catch {
                // An unreadable screen leaves the step at a row a report.
                wheelMeasureTries = WHEEL_MEASURE_TRIES;
            } finally {
                wheelMeasuring = false;
                paintedAt = Date.now();
                if (wheelTimer === undefined) turnWheel();
            }
        };

        /** Pauses the wheel and reports whether the screen then moves up by itself. */
        const followsLiveOutput = async (): Promise<boolean> => {
            const read = this.options.readPaneText;
            if (read === undefined || Math.abs(wheelRows) < wheelStep()) return false;
            clearTimeout(wheelTimer);
            wheelTimer = undefined;
            try {
                // Reports still painting late would move the screen up like live output.
                await new Promise((resolve) => setTimeout(resolve, WHEEL_FOLLOW_SETTLE_MS + (attachment.wheelPaintMs ?? 0)));
                const before = await read(attachment.paneId);
                await new Promise((resolve) => setTimeout(resolve, WHEEL_FOLLOW_WATCH_MS));
                const shift = screenShift(before, await read(attachment.paneId));
                return shift !== undefined && shift < 0;
            } catch {
                return false;
            }
        };
        const goToBottom = async (generation: number, requestId: string): Promise<void> => {
            const deadline = Date.now() + 3_000;
            const active = (): boolean => !finished && !childExited
                && bottomGeneration === generation && this.authorized(attachment);
            const result = (state: 'complete' | 'catching-up'): void => {
                if (active()) this.sendResult(socket, params.channel, { type: 'terminal.bottom-state', requestId, state });
            };
            result('catching-up');
            const read = this.options.readPaneScroll;
            if (read === undefined) return;
            while (active() && Date.now() < deadline) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const scroll = await Promise.race([
                    read(attachment.paneId),
                    new Promise<undefined>((resolve) => {
                        timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
                    }),
                ]).finally(() => clearTimeout(timer));
                if (!active()) return;
                if (scroll === undefined) break;
                if (scroll.maxOffsetFromBottom === 0) {
                    wheelReachedEnd = false;
                    wheelRows = -MAX_WHEEL_ROWS;
                    wheelAt = { column: Math.floor(attachment.cols / 2), row: Math.floor(attachment.rows / 2) };
                    paintedAt = Date.now();
                    turnWheel();
                    let watchAt = Date.now() + WHEEL_FOLLOW_AFTER_MS;
                    while (active() && (wheelMeasuring || Math.abs(wheelRows) >= wheelStep()) && Date.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, SCROLL_STATE_SETTLE_MS));
                        // A program that has gone still is left to the wheel's own stop.
                        if (Date.now() < watchAt || wheelMeasuring || Date.now() - paintedAt > SCROLL_STATE_SETTLE_MS || !active()) continue;
                        const following = await followsLiveOutput();
                        if (!active()) return;
                        if (following) { wheelRows = 0; result('complete'); return; }
                        paintedAt = Date.now();
                        if (wheelTimer === undefined) turnWheel();
                        watchAt = Date.now() + WHEEL_FOLLOW_AFTER_MS;
                    }
                    if (!active()) return;
                    if (wheelReachedEnd) { result('complete'); return; }
                    wheelRows = 0;
                    break;
                }
                if (scroll.offsetFromBottom === 0) {
                    attachment.scrollOffsetFromBottom = 0;
                    attachment.herdrOwnsScroll = true;
                    this.sendResult(socket, params.channel, { type: 'terminal.scroll-state', offsetFromBottom: 0, maxOffsetFromBottom: scroll.maxOffsetFromBottom });
                    result('complete');
                    return;
                }
                session.send(JSON.stringify({ type: 'terminal.scroll', direction: 'down', lines: Math.min(scroll.offsetFromBottom, MAX_WHEEL_ROWS) }));
                await new Promise((resolve) => setTimeout(resolve, SCROLL_STATE_SETTLE_MS));
            }
            result('catching-up');
            this.scheduleScrollState(attachment);
        };

        // Await each link write before reading more from Herdr. LinkStream's
        // credit window alone cannot bound memory if we enqueue writes without
        // awaiting them while a phone stops reading. Pausing stops the kit
        // reading stdout, so the pipe fills and Herdr blocks instead of the
        // host queueing a whole stream for a slow phone.
        const pending: string[] = [];
        let pumping = false;
        const pumpLines = async (): Promise<void> => {
            if (pumping) return;
            pumping = true;
            try {
                while (true) {
                    if (finished) return;
                    const line = pending.shift();
                    if (line === undefined) break;
                    if (line.trim().length === 0) continue;
                    await this.sendToPhone(attachment, line);
                    if (finished) return;
                    if (attachment.scrollOffsetFromBottom > 0) this.scheduleScrollState(attachment);
                    // Only a real full repaint is the initial screen. A closed record
                    // or a stray diagnostic line must not count.
                    if (attachment.initialFrameReceived || !isInitialScreenRecord(line)) continue;
                    attachment.initialFrameReceived = true;
                    this.scheduleScrollState(attachment);
                }
            } finally {
                pumping = false;
            }
            if (!finished) session.resume();
        };
        removeFrameRef = session.onFrame((line) => {
            if (finished) return;
            paintedAt = Date.now();
            session.pause();
            pending.push(line);
            void pumpLines().catch(() => attachment.close());
        });
        // Handshake frames first, in order; the pump below owns pause from here.
        removeEarlyTap();
        for (const line of early.splice(0)) pending.push(line);
        void pumpLines().catch(() => attachment.close());

        // Client input is written to the control stream's stdin verbatim.
        // Observe streams are read-only; drop input silently.
        if (!observe) {
            removeInputRef = socket.onLine(onInput);
        }

        void session.exited.then(({ code, stderrTail }) => {
            // Input must stop now: the stream it would be written to is gone.
            // A send after the child died is a no-op inside the kit.
            removeInput();
            if (finished) return;
            if (!attachment.initialFrameReceived && TRANSIENT_TRANSPORT.test(stderrTail)) {
                // The pane survived; only this transport died. Retire it
                // silently so the phone's ordinary socket-close reattach
                // recovers instead of treating the terminal as ended.
                process.stderr.write(`terminal: herdr transport failed before the first frame on ${paneId}; retiring for reattach\n`);
                finish();
                socket.close();
                return;
            }
            finish(`herdr stream exited (${code ?? 'signal'})`);
        });
        socket.onEnd(() => {
            const remote = !finished;
            finish();
            try {
                if (remote && !childExited) session.close();
            } catch {
                /* already dead */
            }
        });

        return { paneId };
    }

    /**
     * One `pane.get` per settled burst, never one per scroll frame. A fling
     * arrives as a run of scrolls and only the position it ends at is worth
     * publishing; the trailing read is what makes the last one of the run
     * count. Herdr applies the scroll before it repaints, so the small delay
     * also keeps this read behind the scroll it is reporting on.
     */
    private scheduleScrollState(attachment: Attachment): void {
        if (this.options.readPaneScroll === undefined) return;
        attachment.scrollStateDirty = true;
        if (attachment.scrollStateTimer !== undefined || attachment.scrollStateReading) return;
        attachment.scrollStateTimer = setTimeout(() => {
            delete attachment.scrollStateTimer;
            void this.publishScrollState(attachment);
        }, SCROLL_STATE_SETTLE_MS);
    }

    private async publishScrollState(attachment: Attachment): Promise<void> {
        const read = this.options.readPaneScroll;
        if (read === undefined || attachment.scrollStateReading || !this.authorized(attachment)) return;
        attachment.scrollStateReading = true;
        attachment.scrollStateDirty = false;
        try {
            const scroll = await read(attachment.paneId);
            attachment.scrollOffsetFromBottom = scroll.offsetFromBottom;
            attachment.herdrOwnsScroll = scroll.maxOffsetFromBottom > 0;
            if (attachment.herdrOwnsScroll) delete attachment.wheelStep;
            await this.sendToPhone(attachment, JSON.stringify({
                type: 'terminal.scroll-state',
                offsetFromBottom: scroll.offsetFromBottom,
                maxOffsetFromBottom: scroll.maxOffsetFromBottom,
            } satisfies TerminalScrollStateFrame));
        } catch {
            // A pane that cannot be read is not a terminal failure. The phone
            // keeps the last position it was told rather than being lied to.
        } finally {
            attachment.scrollStateReading = false;
            if (attachment.scrollStateDirty) this.scheduleScrollState(attachment);
        }
    }

    private authorized(attachment: Attachment): boolean {
        try {
            attachment.assertAuthorized?.();
            return true;
        } catch {
            attachment.close();
            return false;
        }
    }

    private async sendToPhone(attachment: Attachment, plaintext: string): Promise<void> {
        if (this.authorized(attachment) && attachment.socket.isOpen) await attachment.socket.send(plaintext);
    }

    sendResult(socket: TerminalPipe, channel: string, result: object): void {
        if (socket.isOpen) void Promise.resolve(socket.send(JSON.stringify(result))).catch(() => socket.close());
    }

    private serializeChannel<T>(channel: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.channelQueues.get(channel) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(operation);
        const tail = run.then(() => undefined, () => undefined);
        this.channelQueues.set(channel, tail);
        return run.finally(() => {
            if (this.channelQueues.get(channel) === tail) this.channelQueues.delete(channel);
        });
    }

    async detach(channel: string, authenticatedDeviceId?: string): Promise<void> {
        await this.serializeChannel(channel, async () => {
            const attachment = this.attachments.get(channel);
            if (attachment === undefined) return;
            if (authenticatedDeviceId !== undefined && attachment.deviceId !== authenticatedDeviceId) {
                throw new Error('terminal: channel belongs to another device');
            }
            attachment.close();
        });
    }

    closeAll(): void {
        for (const attachment of [...this.attachments.values()]) attachment.close();
    }
}
