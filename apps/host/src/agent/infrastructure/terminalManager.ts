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
import { wheelReportsAllowed } from './terminalModes.js';
import { programIsGone } from './paneModeReset.js';

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
    /**
     * The pids of the pane's foreground programs, empty while only its shell
     * holds it. Omitted, a scroll is taken to hold a program as before.
     */
    paneForegroundPids?: (paneId: string) => Promise<number[]>;
    /** Restore crashed-program modes only after rechecking shell foreground and no live jobs. Resolves whether a reset landed. */
    restorePaneTerminalModes?: (paneId: string) => Promise<boolean>;
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
    /** The pane's foreground programs, as last probed; undefined until one answers. */
    foregroundPids?: number[];
    /** The last program seen holding the pane, so its death can be told. */
    ownerPid?: number;
    /** The one in-flight foreground probe, so a fling does not stampede Herdr. */
    foregroundProbe?: Promise<void>;
    /** One restore in flight so a fling does not stampede the PTY. */
    modeRestore?: Promise<boolean>;
    /** Rows the program on the alternate screen moved for a burst of that many wheel reports, as last read. */
    wheelResponse?: Map<number, number>;
    /** How long the program took to paint its last measured burst. */
    wheelPaintMs?: number;
    /** Drop any in-flight program wheel after modes are restored to the shell. */
    cancelWheel?: () => void;
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
 * as ONE wheel report whatever its line count (measured on 0.9.1), so the host
 * turns a program's wheel itself, a one-line scroll a report. The cap bounds
 * how long a runaway request can keep the wheel turning.
 */
const MAX_WHEEL_ROWS = 10_000;
/**
 * Programs differ in how far a wheel report moves them, and some accelerate a
 * fast spin: Claude Code moves a row a report for up to four reports sent
 * together but 13 rows for eight, until a 40 ms gap resets it; OpenCode and vim
 * move three rows a report. Turned open loop, a drag ran ahead of the finger,
 * fell short of it, or kept crawling after it lifted. So the wheel turns in
 * bursts, and after each the screen is read: the rows it really moved are what
 * the burst paid off the finger's rows, and sized by the rows each burst size
 * moved before, the next burst never runs past the finger. The rest after a
 * burst lets the program paint and its acceleration reset. Without a screen to
 * read, the wheel turns four reports a burst, a row each.
 */
const WHEEL_MAX_BURST = 8;
/**
 * Rows past any drag's: Latest, which wants the end, not a row count. Its
 * bursts go whole and do not wait to be read; the program going still, or
 * following its own output, is where they stop.
 */
const WHEEL_RUSH_ROWS = 1_000;
const WHEEL_BLIND_BURST = 4;
const WHEEL_REST_MS = 45;
const WHEEL_READ_MS = 20;
/**
 * A burst the program has not painted this long after missed. Claude Code can
 * paint nothing for the first report that turns it off its live edge, so only
 * a second miss in a row means the wheel is at the end it was turned toward.
 */
const WHEEL_STILL_MS = 500;
const WHEEL_END_MISSES = 2;
const MAX_WHEEL_SHIFT = 40;

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
    for (let step = 1; step <= MAX_WHEEL_SHIFT; step++) {
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
        let paintedAt = 0;
        // One burst loop at a time; Latest holds it while it watches the screen.
        let wheelTurning = false;
        let wheelHeld = false;
        attachment.cancelWheel = (): void => {
            wheelRows = 0;
        };
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
                    const generation = bottomGeneration;
                    void goToBottom(generation, requestId).catch(() => {
                        if (!finished && bottomGeneration === generation && this.authorized(attachment)) this.sendResult(socket, params.channel, { type: 'terminal.bottom-state', requestId, state: 'catching-up' });
                    }).finally(() => {
                        if (bottomGeneration === generation) bottomRunning = false;
                    });
                    return;
                }
                const scroll = scrollInput(text);
                if (scroll === undefined) {
                    // A key goes to the program at its live edge; the rest of a
                    // fling must not carry it back up afterwards.
                    wheelRows = 0;
                    session.send(text);
                    return;
                }
                if (attachment.herdrOwnsScroll === true) {
                    // Herdr holds this pane's scrollback: the scroll moves its
                    // viewport, never a program's wheel.
                    session.send(text);
                    this.scheduleScrollState(attachment);
                    return;
                }
                void paneScroll(scroll).catch((error) => {
                    onInputError(error instanceof Error ? error : new Error(String(error)));
                });
            } catch (error) {
                onInputError(error instanceof Error ? error : new Error(String(error)));
            }
        };
        /**
         * A scroll on a pane whose scrollback Herdr may not own: ask whose pane
         * it is before Herdr turns the scroll into a wheel report, so the report
         * only ever reaches a program.
         */
        const paneScroll = async (scroll: ScrollInput): Promise<void> => {
            const live = (): boolean => !finished && !childExited
                && this.attachments.get(params.channel) === attachment
                && this.authorized(attachment);
            await this.probeForeground(attachment);
            if (!live()) return;
            if (!wheelReportsAllowed(attachment.foregroundPids)) {
                // The pane's own shell is in the foreground: Herdr would hand
                // the scroll to it as wheel reports. There is no scrollback of
                // our own to move, so the gesture is dropped and whatever the
                // program left behind is cleared only when no live job remains.
                wheelRows = 0;
                void this.restoreStaleModes(attachment).then(() => this.scheduleScrollState(attachment));
                return;
            }
            const lines = Number(scroll.lines);
            if ((scroll.direction === 'up' || scroll.direction === 'down') && Number.isInteger(lines) && lines > 0) {
                const rows = scroll.direction === 'up' ? lines : -lines;
                // A finger that turns back wants the new way now, not after
                // the rest of the old way is paid off.
                const owed = Math.sign(wheelRows) === -Math.sign(rows) ? rows : wheelRows + rows;
                wheelRows = Math.max(-MAX_WHEEL_ROWS, Math.min(MAX_WHEEL_ROWS, owed));
                wheelAt = { column: scroll.column, row: scroll.row };
                turnWheel();
            } else {
                wheelRows = 0;
            }
            this.scheduleScrollState(attachment);
        };
        const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
        const readScreen = async (): Promise<string | undefined> =>
            this.options.readPaneText?.(attachment.paneId).catch(() => undefined);
        /** Rows a burst of n reports should move, from what bursts moved before. */
        const burstRows = (n: number): number | undefined => {
            const response = attachment.wheelResponse;
            if (response === undefined || response.size === 0) return undefined;
            return response.get(n) ?? n * Math.max(...[...response].map(([reports, rows]) => rows / reports));
        };
        /** Fewer rows than one report moves wait for the finger's next ones. */
        const reportRows = (): number => {
            const response = attachment.wheelResponse;
            return response === undefined ? 1 : Math.min(...[...response].map(([reports, rows]) => rows / reports));
        };
        /**
         * The most reports a burst may hold. It never moves past the rows owed,
         * nor past half the screen, where its move could not be read back. It
         * grows to at most twice the largest burst read yet, so acceleration is
         * met before it is relied on.
         */
        const burstFor = (owed: number, screen: string | undefined): number => {
            if (this.options.readPaneText === undefined) return Math.min(owed, WHEEL_BLIND_BURST);
            if (owed > WHEEL_RUSH_ROWS) return WHEEL_MAX_BURST;
            if (attachment.wheelResponse === undefined) return 1;
            const room = Math.min(owed, Math.floor((screen?.split('\n').length ?? attachment.rows) / 2));
            const most = Math.min(WHEEL_MAX_BURST, 2 * Math.max(...attachment.wheelResponse.keys()));
            let n = 1;
            for (let reports = 2; reports <= most; reports++) if (burstRows(reports)! <= room) n = reports;
            return n;
        };
        /**
         * Waits out a burst's paint: the screen's lines moved, or the program
         * stayed still. A spinner or a clock repainting in place is not a move.
         * Unreadable, any frame counts.
         */
        const waitForPaint = async (before: string | undefined, sentAt: number): Promise<{ painted: boolean; shift: number | undefined; after: string | undefined }> => {
            for (let first = true; ; first = false) {
                // Herdr answers a call on its next tick (about 100 ms), which
                // covers the paint; the rest only matters when it answers at once.
                const [after] = await Promise.all([readScreen(), first ? sleep(WHEEL_REST_MS) : undefined]);
                const shift = before === undefined || after === undefined ? undefined : screenShift(before, after);
                const painted = before === undefined || after === undefined ? paintedAt >= sentAt : shift !== undefined;
                if (painted || finished || Date.now() - sentAt >= WHEEL_STILL_MS) return { painted, shift, after };
                await sleep(WHEEL_READ_MS);
            }
        };
        const turnWheel = (): void => {
            if (wheelTurning || wheelHeld) return;
            wheelTurning = true;
            void payWheel().catch((error) => {
                onInputError(error instanceof Error ? error : new Error(String(error)));
            }).finally(() => {
                wheelTurning = false;
            });
        };
        /**
         * Every burst asks whose pane it is before Herdr turns it into wheel
         * reports: a fling's rows are still owed when its program exits, and
         * those must stop at once instead of reaching the shell. The pane is
         * asked while the burst before paints, so the two calls share a tick.
         */
        const payWheel = async (): Promise<void> => {
            let [before] = await Promise.all([readScreen(), this.probeForeground(attachment)]);
            let asked = Promise.resolve();
            let misses = 0;
            while (!finished && !childExited && Math.abs(wheelRows) >= reportRows() && !wheelHeld) {
                const up = wheelRows > 0;
                const n = burstFor(Math.abs(wheelRows), before);
                await asked;
                if (finished || childExited || wheelHeld || wheelRows === 0) return;
                if (!wheelReportsAllowed(attachment.foregroundPids)) {
                    wheelRows = 0;
                    void this.restoreStaleModes(attachment).then(() => this.scheduleScrollState(attachment));
                    return;
                }
                // The finger turned back while the pane was asked.
                if (wheelRows > 0 !== up) continue;
                const sentAt = Date.now();
                const report = JSON.stringify({ type: 'terminal.scroll', direction: up ? 'up' : 'down', lines: 1, ...wheelAt });
                for (let i = 0; i < n; i++) session.send(report);
                asked = this.probeForeground(attachment);
                if (Math.abs(wheelRows) > WHEEL_RUSH_ROWS) {
                    await sleep(WHEEL_REST_MS);
                    before = undefined;
                    if (Date.now() - paintedAt <= WHEEL_STILL_MS) continue;
                    wheelRows = 0;
                    wheelReachedEnd = true;
                    return;
                }
                const { painted, shift, after } = await waitForPaint(before, sentAt);
                // Unmoved, the reading it was measured from stays the baseline.
                if (painted || after === undefined) before = after;
                // Rows owed the other way now are the finger's, not this burst's.
                if (wheelRows === 0 || wheelRows > 0 !== up) continue;
                if (!painted) {
                    if (++misses < WHEEL_END_MISSES) continue;
                    wheelRows = 0;
                    wheelReachedEnd = true;
                    return;
                }
                misses = 0;
                const moved = shift === undefined ? undefined : up ? shift : -shift;
                if (moved !== undefined && moved > 0) {
                    (attachment.wheelResponse ??= new Map()).set(n, moved);
                    attachment.wheelPaintMs = Date.now() - sentAt;
                }
                // A screen that moved some other way (its own output) still pays a row.
                const paid = Math.max(1, moved ?? burstRows(n) ?? n);
                wheelRows = up ? Math.max(0, wheelRows - paid) : Math.min(0, wheelRows + paid);
            }
        };

        /** Pauses the wheel and reports whether the screen then moves up by itself. */
        const followsLiveOutput = async (): Promise<boolean> => {
            const read = this.options.readPaneText;
            if (read === undefined || wheelRows === 0) return false;
            wheelHeld = true;
            try {
                // Reports still painting late would move the screen up like live output.
                await new Promise((resolve) => setTimeout(resolve, WHEEL_FOLLOW_SETTLE_MS + (attachment.wheelPaintMs ?? WHEEL_STILL_MS)));
                const before = await read(attachment.paneId);
                await new Promise((resolve) => setTimeout(resolve, WHEEL_FOLLOW_WATCH_MS));
                const shift = screenShift(before, await read(attachment.paneId));
                return shift !== undefined && shift < 0;
            } catch {
                return false;
            } finally {
                wheelHeld = false;
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
                    await this.probeForeground(attachment);
                    if (!active()) return;
                    if (!wheelReportsAllowed(attachment.foregroundPids)) {
                        // The pane's own shell holds it: a wheel would land in
                        // its line editor, and Latest has nowhere to turn.
                        if (await this.restoreStaleModes(attachment)) this.scheduleScrollState(attachment);
                        result('complete');
                        return;
                    }
                    wheelReachedEnd = false;
                    wheelRows = -MAX_WHEEL_ROWS;
                    wheelAt = { column: Math.floor(attachment.cols / 2), row: Math.floor(attachment.rows / 2) };
                    paintedAt = Date.now();
                    turnWheel();
                    let watchAt = Date.now() + WHEEL_FOLLOW_AFTER_MS;
                    while (active() && wheelRows !== 0 && Date.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, SCROLL_STATE_SETTLE_MS));
                        // A program that has gone still is left to the wheel's own stop.
                        if (Date.now() < watchAt || Date.now() - paintedAt > SCROLL_STATE_SETTLE_MS || !active()) continue;
                        const following = await followsLiveOutput();
                        if (!active()) return;
                        if (following) { wheelRows = 0; result('complete'); return; }
                        paintedAt = Date.now();
                        turnWheel();
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
            if (attachment.herdrOwnsScroll === false && attachment.foregroundPids === undefined) {
                // Whose pane this is decides the wheel gate; the first answer is
                // taken here, so a program is on record while it still holds the
                // pane.
                await this.probeForeground(attachment);
            }
            if (attachment.herdrOwnsScroll) {
                delete attachment.wheelResponse;
                delete attachment.wheelPaintMs;
            }
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

    /**
     * Ask Herdr whose pane this is now. One probe is in flight at a time, so a
     * fling does not stampede it; a probe that fails leaves the last answer.
     */
    private async probeForeground(attachment: Attachment): Promise<void> {
        const read = this.options.paneForegroundPids;
        if (read === undefined) return;
        attachment.foregroundProbe ??= read(attachment.paneId)
            .then((programs) => {
                attachment.foregroundPids = programs;
                const owner = programs[programs.length - 1];
                if (owner !== undefined) attachment.ownerPid = owner;
            })
            .catch(() => undefined)
            .finally(() => {
                delete attachment.foregroundProbe;
            });
        await attachment.foregroundProbe;
    }

    /**
     * The pane's own shell holds it and no live program is left on it, so
     * what a crashed program left on the screen is nobody's: inject the reset as
     * PTY output so Herdr's scrollback returns and wheel reports stop typing
     * into the shell. Resolves whether a reset landed; a pane that could
     * not be reset is retried by the next scroll.
     */
    private async restoreStaleModes(attachment: Attachment): Promise<boolean> {
        const restore = this.options.restorePaneTerminalModes;
        if (restore === undefined || wheelReportsAllowed(attachment.foregroundPids)) return false;
        if (attachment.herdrOwnsScroll === true) return false;
        // A program we saw still alive (stopped or backgrounded) keeps its screen.
        const owner = attachment.ownerPid;
        if (owner !== undefined && !programIsGone(owner)) return false;
        // An unseen crash has no owner pid. The source rechecks shell
        // foreground and the absence of live children immediately before writing.
        if (attachment.modeRestore !== undefined) return await attachment.modeRestore;
        const pending = (async (): Promise<boolean> => {
            let landed = false;
            try {
                landed = await restore(attachment.paneId);
                if (!landed) return false;
                // The pane's shell owns it again; forget the program that left.
                delete attachment.ownerPid;
                delete attachment.wheelResponse;
                delete attachment.wheelPaintMs;
                attachment.cancelWheel?.();
            } catch {
                /* A failed reset keeps the owner recorded; the next scroll retries. */
            } finally {
                delete attachment.modeRestore;
            }
            return landed;
        })();
        attachment.modeRestore = pending;
        return await pending;
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
