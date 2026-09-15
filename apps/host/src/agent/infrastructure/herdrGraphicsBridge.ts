import { execFile } from 'node:child_process';
import { InlineKittyScanner, type InlineKittyBlock } from './inlineKitty.js';
import { graphicsTrace } from './graphicsTrace.js';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { deflate } from 'node:zlib';
import { promisify } from 'node:util';
import type { TerminalGraphicsReason } from '@muxr/contract';

const PROTOCOL_VERSION = 20;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const KITTY_CHUNK_CHARS = 4096;
const LAYOUT_CACHE_MS = 250;
/**
 * How often an aggregate pipeline account is reported while frames flow. Short
 * enough that a single measured window -- a phone scrolling for ninety seconds
 * -- always leaves one behind.
 */
const PIPELINE_REPORT_MS = 15_000;
/**
 * No producer publishes its wheel detent -- a browser scrolls 120 CSS pixels a
 * notch, a pager three lines, a viewer one -- so a notch is treated as what a
 * physical wheel delivers for the same gesture: three rows of travel. Every
 * program already tunes itself to that unit.
 */
const WHEEL_ROWS_PER_NOTCH = 3;
/**
 * A notch is a repaint, and a repaint is a full frame across a slow socket, so
 * the gesture is bounded by frames in flight rather than by a fixed count: the
 * rest of the intent is drained one notch per delivered frame. A fling then
 * travels as fast as the pane can actually keep up.
 */
const MAX_NOTCHES_IN_FLIGHT = 4;
const MAX_NOTCH_BACKLOG = 8;
/** Programs that never repaint must still scroll, so a frame is not required. */
const NOTCH_FALLBACK_MS = 100;
/** Deflate harder once a frame is large: the phone decrypts every byte in JS. */
const COMPRESS_HARDER_BYTES = 512 * 1024;
/** Keep the old switch as a kill switch for the adaptive coarse path. */
const ADAPTIVE_DENSITY = process.env.MUXR_GRAPHICS_HALVE !== '0';
/** A frame is refined only after both input and producer activity are quiet. */
const SETTLE_REFINE_MS = 200;
/** Optional source pixels never get to consume the whole bridge. */
export const MAX_REFINEMENT_BYTES = 32 * 1024 * 1024;
const compress = promisify(deflate);
const run = promisify(execFile);

export interface HerdrGraphicsRegistration {
    channel: string;
    paneId: string;
    cols: number;
    rows: number;
    cellWidthPx: number;
    cellHeightPx: number;
    write: (frame: string) => void;
    /** Input this bridge owes the pane later, such as the rest of a gesture. */
    sendInput?: (bytes: Buffer) => void;
}

export interface HerdrGraphicsPointer {
    phase: 'down' | 'move' | 'up';
    x: number;
    y: number;
    width: number;
    height: number;
}

type GraphicsFile = {
    path: string;
    expectedLength: bigint;
    imageId: number;
    transferId: bigint;
    leading: Buffer;
    control: string;
};

export type PreparedImage = {
    compressed: Buffer;
    width: number;
    height: number;
    imageId: number;
    transferId: bigint;
    /**
     * The producer's own pixel dimensions, when the transmitted image was
     * downscaled. Pointer reports are injected in the producer's pixel space,
     * never the transmitted one, so they are mapped against these.
     */
    sourceWidth?: number;
    sourceHeight?: number;
};

type ImageOwner = { paneId: string; imageId: number; sourceImageId: number };
type AdmittedTransfer = {
    sourceImageId: number;
    generation: number;
    retired: boolean;
    paneId?: string;
};
type AppGeometry = { cols: number; rows: number; cellWidthPx: number; cellHeightPx: number };

export type GraphicsRoute = { paneId: string; rect?: { x: number; y: number; width: number; height: number } };
export type GraphicsPlacement = { col: number; row: number; cols: number; rows: number };
type Rect = NonNullable<GraphicsRoute['rect']>;
type ServerMessage =
    | { type: 'welcome'; version: number; error?: string }
    | { type: 'graphics'; bytes: Buffer }
    | { type: 'output'; bytes: Buffer }
    | { type: 'graphics-file'; file: GraphicsFile }
    | { type: 'retired'; transferId: bigint; imageId: number }
    | { type: 'closed' }
    | { type: 'other' };

type DirectRawFrame = { rgba: Buffer; control: string; imageId: number; transferId: bigint; sourceImageId: number };
/** A queued full-density replay of a pane's latest image. */
type DirectRefineWork = { refinePane: string; at: number; reason: 'gesture' | 'source'; sourceRevision: number; sourceQueueVersion: number; fenceRetry: boolean };

/**
 * Where a pane stands with Herdr's one active surface. `rect` is its area when
 * it is on that surface; `onActiveSurface: false` means Herdr will render no
 * graphics for it at all. `undefined` from the lookup means we could not tell,
 * which is never reported as anything.
 */
type PaneVisibility = { rect?: Rect; onActiveSurface: boolean };

/** A gesture's remaining intent, newest direction wins. */
type ScrollPoint = { x: number; y: number };
type ScrollIntent = { direction: 'up' | 'down'; notches: number; point: ScrollPoint };


/** Aggregate, identifier-free account of what the pipeline did. */
export type GraphicsPipelineReport = {
    frames: number;
    superseded: number;
    p50Ms: number;
    p95Ms: number;
    bytesP95: number;
    pixelsP95: number;
    /** Wheel notches released to the pane, and gesture intent the cap dropped. */
    notchesSent: number;
    notchesDropped: number;
    /**
     * How the rest of a gesture actually got out. A notch drained by a
     * delivered frame is the pane keeping up; one drained by the 100ms
     * fallback is the pane not answering, and a gesture spent entirely in
     * that mode travels at ten notches a second however fast the finger
     * moved. Both are subsets of notchesSent, whose remainder is the
     * immediate release at the start of each gesture.
     */
    notchesByFrame: number;
    notchesByTimer: number;
};

/**
 * One process-wide graphics frontend for Herdr's one allowed direct-graphics
 * app client. Registrations remain per phone channel and pane. Every frame is
 * routed from its authoritative full-app placement through a fresh pane.layout
 * query; ambiguous or stale matches are dropped, never guessed.
 */
export class HerdrGraphicsBridge {
    private readonly registrations = new Map<string, HerdrGraphicsRegistration>();
    private readonly latestByPane = new Map<string, PreparedImage>();
    private readonly imageOwners = new Map<bigint, ImageOwner>();
    private readonly pendingByOrigin = new Map<string, GraphicsFile>();
    private readonly pendingOrigins: string[] = [];
    private readonly layoutCache = new Map<string, { expiresAt: number; value: Promise<PaneVisibility | undefined> }>();
    /** Panes already told they are off Herdr's active surface, so it is said once. */
    private readonly offSurfacePanes = new Set<string>();
    private readonly paneProcessGroups = new Map<string, number>();
    private readonly processProbeAttempted = new Set<string>();
    private readonly processProbeFailures = new Map<string, number>();
    private readonly admitted = new Map<bigint, AdmittedTransfer>();
    private readonly paneRetiredGeneration = new Map<string, number>();
    private workspaceCache: { expiresAt: number; value: Promise<{ workspaceId: string; tabId: string } | undefined> } | undefined;
    private lastErrorAt = 0;
    private processTimer: ReturnType<typeof setInterval> | undefined;
    private pollingProcesses = false;
    private readonly inlineScanner = new InlineKittyScanner();
    /** Notches a pane has yet to answer, and the intent still owed to it. */
    private readonly scrollInFlight = new Map<string, number>();
    private readonly scrollBacklog = new Map<string, ScrollIntent>();
    private readonly scrollTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly refineTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly lastSourceAt = new Map<string, number>();
    /** When a notch was last actually released into the pane. */
    private readonly lastInputAt = new Map<string, number>();
    private readonly sourceRevision = new Map<string, number>();
    /** Diagnostic only: which pane last moved the shared fence. */
    private fenceBumpPane: string | undefined;
    private readonly directRawByPane = new Map<string, DirectRawFrame>();
    private directRefinementBytes = 0;
    private readonly directRefineQueue: DirectRefineWork[] = [];
    private sourceQueueVersion = 0;
    private readonly latencies: number[] = [];
    private readonly frameBytes: number[] = [];
    private readonly framePixels: number[] = [];
    private supersededFrames = 0;
    private notchesSent = 0;
    private notchesDropped = 0;
    private notchesByFrame = 0;
    private notchesByTimer = 0;
    private reportTimer: ReturnType<typeof setInterval> | undefined;
    private input = Buffer.alloc(0);
    private draining = false;
    private nextImageId = 1;
    private nextGeneration = 0;
    private closed = false;

    private constructor(
        private readonly socket: Socket,
        private readonly herdrBin: string,
        private readonly onPipelineReport?: (report: GraphicsPipelineReport) => void,
    ) {
        socket.on('data', (data: Buffer) => { this.read(data); });
        socket.on('error', (error) => { process.stderr.write(`terminal graphics: ${error.message}\n`); this.close(); });
        socket.on('close', () => { this.close(); });
        // One tick, already here for the pipeline account: it now also notices a
        // pane that has left Herdr's active surface while a phone was watching.
        this.reportTimer = setInterval(() => {
            this.reportPipeline();
            void this.announceOffSurfacePanes();
        }, PIPELINE_REPORT_MS);
        this.reportTimer.unref();
    }

    static async open(options: {
        cellWidthPx: number;
        cellHeightPx: number;
        herdrBin?: string;
        socketPath?: string;
        onPipelineReport?: (report: GraphicsPipelineReport) => void;
    }): Promise<HerdrGraphicsBridge> {
        if (process.platform === 'win32') throw new Error('Herdr direct graphics requires a Unix client socket');
        const herdrBin = options.herdrBin ?? 'herdr';
        const geometry = await appGeometry(herdrBin, options.cellWidthPx, options.cellHeightPx);
        const socketPath = options.socketPath ?? process.env.HERDR_CLIENT_SOCKET_PATH
            ?? join(homedir(), '.config', 'herdr', 'herdr-client.sock');
        const socket = createConnection(socketPath);
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        const bridge = new HerdrGraphicsBridge(socket, herdrBin, options.onPipelineReport);
        bridge.write(clientHello(geometry));
        return bridge;
    }

    register(registration: HerdrGraphicsRegistration): boolean {
        if (this.closed || !validRegistration(registration)) return false;
        this.registrations.set(registration.channel, registration);
        this.layoutCache.delete(registration.paneId);
        this.workspaceCache = undefined;
        if (!this.paneProcessGroups.has(registration.paneId)) this.processProbeAttempted.delete(registration.paneId);
        // A phone joining late is owed whatever the pane is showing.
        const latest = this.latestByPane.get(registration.paneId);
        void this.announceOffSurfacePanes();
        if (latest !== undefined) {
            registration.write(terminalFrame(encodeKitty(latest, registration, 'all'), registration, true));
        }
        return true;
    }

    unregister(channel: string): void {
        const removed = this.registrations.get(channel);
        this.registrations.delete(channel);
        if (removed !== undefined) {
            this.layoutCache.delete(removed.paneId);
            if (![...this.registrations.values()].some((item) => item.paneId === removed.paneId)) {
                this.clearScrollState(removed.paneId);
            }
        }
        this.workspaceCache = undefined;
        // A phone leaving its last pane is a natural end of a window; the
        // account is worth nothing if it only lands when the process exits.
        if (this.registrations.size === 0) this.reportPipeline();
    }

    hasRegistrations(): boolean { return this.registrations.size > 0; }

    /** True when a program owns this pane's scrolling, so Herdr must not. */
    ownsScroll(channel: string): boolean {
        const registration = this.registrations.get(channel);
        if (registration === undefined) return false;
        return this.latestByPane.has(registration.paneId);
    }

    /**
     * A phone reports the finger's travel in terminal rows; a program scrolls in
     * wheel notches. Three rows is one notch, as a physical wheel would deliver,
     * and only a few notches are ever in flight: each one costs the producer a
     * repaint and the phone a frame, so the rest of a fling is drained as fast
     * as frames actually come back rather than queued in front of them.
     */
    scrollInput(channel: string, direction: 'up' | 'down', lines: number, at?: Omit<HerdrGraphicsPointer, 'phase'>): Buffer[] {
        const registration = this.registrations.get(channel);
        if (registration === undefined || !this.ownsScroll(channel)) return [];
        const rows = Math.max(0, Math.trunc(lines));
        if (rows === 0) return [];
        const paneId = registration.paneId;
        const image = this.latestByPane.get(paneId);
        if (image === undefined) return [];
        const sourceWidth = image.sourceWidth ?? image.width;
        const sourceHeight = image.sourceHeight ?? image.height;
        const point = at === undefined ? { x: Math.ceil(sourceWidth / 2), y: Math.ceil(sourceHeight / 2) }
            : mapGraphicsPointer(image, registration, { ...at, phase: 'move' });
        if (point === undefined) return [];
        // Any new scroll intent invalidates a sharp replay, including intent
        // that is already at the backlog cap and releases no notch today.
        this.cancelRefine(paneId);
        const wanted = Math.max(1, Math.round(rows / WHEEL_ROWS_PER_NOTCH));
        const inFlight = this.scrollInFlight.get(paneId) ?? 0;
        const now = Math.max(0, Math.min(wanted, MAX_NOTCHES_IN_FLIGHT - inFlight));
        const backlog = this.scrollBacklog.get(paneId);
        const sameTarget = backlog?.direction === direction && backlog.point.x === point.x && backlog.point.y === point.y;
        const carried = sameTarget ? backlog.notches : 0;
        if (backlog && !sameTarget) this.notchesDropped += backlog.notches;
        const intended = carried + wanted - now;
        const owed = Math.min(MAX_NOTCH_BACKLOG, intended);
        // Intent above the cap is thrown away, so it is counted: a fling that
        // travels less than the finger asked has to be visible somewhere.
        if (intended > owed) this.notchesDropped += intended - owed;
        if (owed > 0) this.scrollBacklog.set(paneId, { direction, notches: owed, point });
        else this.scrollBacklog.delete(paneId);
        if (now === 0) return [];
        this.scrollInFlight.set(paneId, inFlight + now);
        this.armNotchFallback(paneId);
        const report = this.wheelReport(paneId, direction, point);
        if (report === undefined) return [];
        this.lastInputAt.set(paneId, Date.now());
        this.notchesSent += now;
        return Array.from({ length: now }, () => report);
    }

    /** One notch of the remaining gesture, released by a frame or the clock. */
    private drainNotch(paneId: string, source: 'frame' | 'timer'): void {
        const inFlight = this.scrollInFlight.get(paneId) ?? 0;
        const backlog = this.scrollBacklog.get(paneId);
        graphicsTrace?.add('input.release', {
            pane: paneId, inFlight, backlog: backlog?.notches ?? 0,
        });
        if (backlog === undefined || backlog.notches <= 0) {
            if (inFlight <= 1) this.clearScrollState(paneId);
            else this.scrollInFlight.set(paneId, inFlight - 1);
            return;
        }
        const report = this.wheelReport(paneId, backlog.direction, backlog.point);
        if (report === undefined) { this.clearScrollState(paneId); return; }
        if (backlog.notches <= 1) this.scrollBacklog.delete(paneId);
        else this.scrollBacklog.set(paneId, { ...backlog, notches: backlog.notches - 1 });
        for (const registration of this.registrations.values()) {
            if (registration.paneId === paneId) registration.sendInput?.(report);
        }
        // Only a notch that really reached the pane is input activity; an
        // ordinary frame delivery calls this too and must not move the clock.
        this.lastInputAt.set(paneId, Date.now());
        this.notchesSent += 1;
        if (source === 'frame') this.notchesByFrame += 1;
        else this.notchesByTimer += 1;
        this.armNotchFallback(paneId);
    }

    /** A program that never repaints must still scroll, just not unboundedly. */
    private armNotchFallback(paneId: string): void {
        const existing = this.scrollTimers.get(paneId);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.scrollTimers.delete(paneId);
            if (this.closed) return;
            this.drainNotch(paneId, 'timer');
        }, NOTCH_FALLBACK_MS);
        timer.unref();
        this.scrollTimers.set(paneId, timer);
    }

    private clearScrollState(paneId: string): void {
        const wasActive = this.gestureActive(paneId);
        this.scrollInFlight.delete(paneId);
        this.scrollBacklog.delete(paneId);
        const timer = this.scrollTimers.get(paneId);
        if (timer !== undefined) clearTimeout(timer);
        this.scrollTimers.delete(paneId);
        if (wasActive) this.armRefine(paneId, 'gesture');
    }

    /** True while a gesture this pane owes frames to is still in flight. */
    private gestureActive(paneId: string): boolean {
        return (this.scrollInFlight.get(paneId) ?? 0) > 0 || this.scrollBacklog.has(paneId);
    }

    /** Coarse while input or the producer is active; sharp once both settle. */
    private halveFor(paneId: string): boolean {
        if (!ADAPTIVE_DENSITY) return false;
        if (this.gestureActive(paneId)) return true;
        const last = this.lastSourceAt.get(paneId);
        return last !== undefined && Date.now() - last < SETTLE_REFINE_MS;
    }

    /** Mark a routed producer frame as activity that keeps the pane coarse. */
    private noteSourceActivity(paneId: string): void {
        this.lastSourceAt.set(paneId, Date.now());
        this.sourceRevision.set(paneId, (this.sourceRevision.get(paneId) ?? 0) + 1);
        this.cancelRefine(paneId);
        graphicsTrace?.add('source.route', {
            pane: paneId,
            revision: this.sourceRevision.get(paneId) ?? 0,
            fence: this.sourceQueueVersion,
            gesture: this.gestureActive(paneId),
        });
    }

    /**
     * Fence attribution for the trace. A direct admission bump happens before
     * routing, so its pane is genuinely unknown; report nothing rather than
     * labelling an unknown bump as another pane's.
     */
    private fenceProvenance(paneId: string): Record<string, string | boolean> {
        if (this.fenceBumpPane === undefined) return {};
        return { fenceBy: this.fenceBumpPane, fenceSamePane: this.fenceBumpPane === paneId };
    }

    /**
     * A refinement discarded after its await by a fence the target pane did not
     * move is still wanted: the pane is settled and would otherwise stay coarse
     * until its producer happens to paint again. A later same-pane arrival
     * cancels this arm through noteSourceActivity, so it cannot show stale
     * pixels.
     */
    private rearmAfterFenceLoss(paneId: string, sourceRevision: number): boolean {
        if (this.gestureActive(paneId)) return false;
        if ((this.sourceRevision.get(paneId) ?? 0) !== sourceRevision) return false;
        this.armRefine(paneId, 'source', SETTLE_REFINE_MS, true);
        return true;
    }

    /** Which pane last moved the shared fence, so a reject can name the cause. */
    private bumpSourceQueueVersion(paneId: string | undefined, path: 'direct' | 'clear'): void {
        this.sourceQueueVersion += 1;
        this.fenceBumpPane = paneId;
        graphicsTrace?.add('fence.bump', { pane: paneId, path, fence: this.sourceQueueVersion });
    }

    /**
     * The moment this pane becomes eligible: one settle window after the later
     * of its final routed source and its final released input. Preparing the
     * coarse frame consumes part of that window, so arming a fresh full window
     * afterwards would charge a slow encode to the viewer twice.
     */
    private quietDeadline(paneId: string): number {
        return Math.max(this.lastSourceAt.get(paneId) ?? 0, this.lastInputAt.get(paneId) ?? 0) + SETTLE_REFINE_MS;
    }

    private sourceQuiet(paneId: string): boolean {
        return Date.now() >= this.quietDeadline(paneId);
    }

    /** Schedule one serialized refinement for a pane, never a timer per frame. */
    private armRefine(paneId: string, reason: 'gesture' | 'source', delay?: number, fenceRetry = false): void {
        this.cancelRefine(paneId);
        const armedAt = Date.now();
        delay ??= Math.max(0, this.quietDeadline(paneId) - armedAt);
        graphicsTrace?.add('refine.arm', {
            pane: paneId,
            reason,
            delayMs: Math.max(0, delay),
            // Absolute deadline: the quiet rule this arm is promising to meet.
            deadline: armedAt + Math.max(0, delay),
            lastSourceAt: this.lastSourceAt.get(paneId),
        });
        const timer = setTimeout(() => {
            this.refineTimers.delete(paneId);
            const work = {
                refinePane: paneId,
                at: Date.now(),
                reason,
                sourceRevision: this.sourceRevision.get(paneId) ?? 0,
                sourceQueueVersion: this.sourceQueueVersion,
                fenceRetry,
            } satisfies DirectRefineWork;
            graphicsTrace?.add('refine.fire', {
                pane: paneId,
                reason,
                path: 'direct',
                lateMs: Date.now() - (armedAt + Math.max(0, delay)),
                fence: this.sourceQueueVersion,
            });
            this.directRefineQueue.push(work);
            if (!this.draining) void this.drain();
        }, Math.max(0, delay));
        timer.unref();
        this.refineTimers.set(paneId, timer);
    }

    private cancelRefine(paneId: string): void {
        const timer = this.refineTimers.get(paneId);
        if (timer !== undefined) clearTimeout(timer);
        this.refineTimers.delete(paneId);
    }

    private wheelReport(paneId: string, direction: 'up' | 'down', point: ScrollPoint): Buffer | undefined {
        const image = this.latestByPane.get(paneId);
        if (image === undefined) return undefined;
        const button = direction === 'up' ? 64 : 65;
        const x = Math.max(1, Math.min(image.sourceWidth ?? image.width, point.x));
        const y = Math.max(1, Math.min(image.sourceHeight ?? image.height, point.y));
        // A phone drag has no preceding mouse move. Position the program's
        // pointer without pressing a button before delivering its wheel notch.
        return Buffer.from(`\u001b[<35;${x};${y}M\u001b[<${button};${x};${y}M`);
    }

    pointerInput(channel: string, pointer: HerdrGraphicsPointer): Buffer[] {
        const registration = this.registrations.get(channel);
        const image = registration === undefined ? undefined : this.latestByPane.get(registration.paneId);
        if (registration === undefined || image === undefined || !validPointer(pointer)) return [];
        const mapped = mapGraphicsPointer(image, registration, pointer);
        if (mapped === undefined) return [];
        if (pointer.phase === 'down') return [Buffer.from(`\u001b[<35;${mapped.x};${mapped.y}M`), Buffer.from(`\u001b[<0;${mapped.x};${mapped.y}M`)];
        return [Buffer.from(`\u001b[<${pointer.phase === 'move' ? 32 : 0};${mapped.x};${mapped.y}${pointer.phase === 'up' ? 'm' : 'M'}`)];
    }

    close(): void {
        this.shutdown('bridge-closed');
    }

    private shutdown(reason?: TerminalGraphicsReason): void {
        if (this.closed) return;
        graphicsTrace?.flush();
        try { if (this.socket.writable) this.socket.write(frame(clientDetach())); } catch { /* socket already closed */ }
        this.closed = true;
        for (const registration of this.registrations.values()) {
            registration.write(graphicsStoppedFrame(registration.cols, registration.rows, reason));
        }
        this.registrations.clear();
        this.latestByPane.clear();
        this.imageOwners.clear();
        for (const timer of this.scrollTimers.values()) clearTimeout(timer);
        this.scrollTimers.clear();
        this.pendingByOrigin.clear();
        this.pendingOrigins.length = 0;
        this.layoutCache.clear();
        this.paneProcessGroups.clear();
        this.processProbeAttempted.clear();
        this.processProbeFailures.clear();
        this.admitted.clear();
        this.paneRetiredGeneration.clear();
        for (const timer of this.refineTimers.values()) clearTimeout(timer);
        this.refineTimers.clear();
        this.lastSourceAt.clear();
        this.lastInputAt.clear();
        this.sourceRevision.clear();
        this.directRawByPane.clear();
        this.directRefinementBytes = 0;
        this.directRefineQueue.length = 0;
        this.nextGeneration += 1;
        this.workspaceCache = undefined;
        if (this.processTimer !== undefined) clearInterval(this.processTimer);
        this.processTimer = undefined;
        this.reportPipeline();
        if (this.reportTimer !== undefined) clearInterval(this.reportTimer);
        this.reportTimer = undefined;
        this.socket.destroy();
    }

    private write(payload: Buffer): void {
        if (!this.closed && this.socket.writable) this.socket.write(frame(payload));
    }

    private read(data: Buffer): void {
        this.input = Buffer.concat([this.input, data]);
        while (this.input.length >= 4) {
            const length = this.input.readUInt32LE(0);
            if (length > MAX_MESSAGE_BYTES) { this.close(); return; }
            if (this.input.length < length + 4) return;
            const payload = this.input.subarray(4, length + 4);
            this.input = this.input.subarray(length + 4);
            let message: ServerMessage;
            try { message = decodeServerMessage(payload); } catch (error) {
                process.stderr.write(`terminal graphics: ${error instanceof Error ? error.message : String(error)}\n`);
                this.close();
                return;
            }
            if (message.type === 'welcome') {
                if (message.error !== undefined || message.version !== PROTOCOL_VERSION) {
                    process.stderr.write(`terminal graphics: Herdr protocol ${message.version} is not supported${message.error === undefined ? '' : `: ${message.error}`}\n`);
                    this.close();
                }
            } else if (message.type === 'output') {
                this.queueInline(message.bytes);
            } else if (message.type === 'graphics') {
                // Protocol 20 provides no pane provenance. Drop rather than
                // crossing streams; PTY-inline Kitty is outside this bridge.
            } else if (message.type === 'graphics-file') {
                this.enqueue(message.file);
            } else if (message.type === 'retired') {
                // Per-transfer retirement, not a connection event: herdr's
                // expire_direct_graphics emits it on every server tick whenever
                // a slot's lease/generation is superseded, and the direct
                // socket stays open. Only `closed` (or the socket itself) ends
                // the bridge; tearing down here forced a reconnect and a
                // clear-all repaint on every replaced frame.
                this.retire(message.transferId, message.imageId);
            } else if (message.type === 'closed') {
                this.close();
            }
        }
    }

    /**
     * Herdr transmits a direct-graphics image's pixels as a leased file, but
     * places and deletes it with Kitty APC commands written into the app
     * output stream. Pixels a program writes to its own PTY are not supported
     * and their transmissions are ignored; only placement and delete commands
     * naming an image this bridge delivered are acted on.
     */
    private queueInline(bytes: Buffer): void {
        if (this.closed) return;
        const at = Date.now();
        for (const block of this.inlineScanner.scan(bytes)) {
            if (this.closed) return;
            if (this.registrations.size === 0) continue;
            const action = block.keys.a ?? 'p';
            if (action !== 'd' && action !== 'p') continue;
            this.forwardControlBlock(block, at);
        }
    }

    /** Translate one of Herdr's control commands to the ids the phone holds. */
    private forwardControlBlock(block: InlineKittyBlock, at: number): void {
        const action = block.keys.a ?? 'p';
        if (action === 'd') {
            const direct = this.forgetPlacements(block);
            for (const registration of this.registrations.values()) {
                // The delete frame's metadata must report what the pane still
                // owns, never an unconditional end: a lowercase hide keeps the
                // resident image (Herdr replays it with a placement-only
                // command), so takeover and the phone's magnifier survive the
                // repaint that hid it. Only a pane left owning nothing really
                // lost its image.
                const graphics = this.latestByPane.has(registration.paneId);
                // A delete naming every image needs no translation; one naming
                // a single image carries Herdr's source id, which cannot
                // address the id this bridge re-numbered it to.
                if (direct.length === 0) registration.write(terminalFrame(wrapAtOrigin(block.bytes), registration, graphics));
                for (const image of direct) {
                    if (registration.paneId !== image.paneId) continue;
                    const placement = block.keys.p === undefined ? '' : `,p=${image.imageId & 0x7fffffff}`;
                    const bytes = Buffer.from(`\u001b_Ga=d,d=${block.keys.d ?? 'a'},i=${image.imageId}${placement},q=2;\u001b\\`);
                    registration.write(terminalFrame(wrapAtOrigin(bytes), registration, graphics));
                }
            }
            return;
        }
        const sourceImageId = Number(block.keys.i ?? block.keys.I);
        for (const owner of this.imageOwners.values()) {
            if (owner.sourceImageId !== sourceImageId) continue;
            const image = this.latestByPane.get(owner.paneId);
            if (image?.imageId !== owner.imageId) continue;
            for (const registration of this.registrations.values()) {
                if (registration.paneId !== owner.paneId) continue;
                const { row, col, cols, rows } = graphicsPlacement(image, registration);
                const bytes = Buffer.from(`\u001b7\u001b[${row + 1};${col + 1}H\u001b_Ga=p,i=${image.imageId},p=${image.imageId & 0x7fffffff},c=${cols},r=${rows},z=0,C=1,q=2;\u001b\\\u001b8`);
                const frame = terminalFrame(bytes, registration, true);
                registration.write(frame);
                this.recordFrame(at, frame.length, image.width * image.height);
            }
        }
    }

    /**
     * Keep our view of what a pane shows in step with a program's delete.
     * Returns the direct-file images the delete named, per pane, by the image
     * id the phone holds: the verbatim bytes carry Herdr's source id, which
     * cannot address a direct-file image this bridge re-numbered on transfer.
     *
     * Lowercase scopes remove placements but keep resident pixels. Herdr
     * replays those with a=p, without sending the leased image again.
     */
    private forgetPlacements(block: InlineKittyBlock): { paneId: string; imageId: number }[] {
        const scope = block.keys.d ?? 'a';
        const target = Number(block.keys.i ?? block.keys.I);
        const all = scope === 'a' || scope === 'A';
        const deletesImage = scope === 'I' || scope === 'A';
        const direct: { paneId: string; imageId: number }[] = [];
        for (const [transferId, owner] of this.imageOwners) {
            if (!all && (owner.sourceImageId !== target || (scope !== 'i' && scope !== 'I'))) continue;
            if (deletesImage) {
                this.imageOwners.delete(transferId);
                const latest = this.latestByPane.get(owner.paneId);
                if (latest?.transferId === transferId) {
                    this.latestByPane.delete(owner.paneId);
                    this.dropDirectRefinement(owner.paneId);
                    this.cancelRefine(owner.paneId);
                }
            }
            if (!all) direct.push({ paneId: owner.paneId, imageId: owner.imageId });
        }
        return direct;
    }

    private recordFrame(startedAt: number, bytes: number, pixels: number): void {
        if (this.onPipelineReport === undefined) return;
        push(this.latencies, Date.now() - startedAt);
        push(this.frameBytes, bytes);
        push(this.framePixels, pixels);
    }

    private reportPipeline(): void {
        if (this.onPipelineReport === undefined) return;
        if (this.latencies.length === 0 && this.supersededFrames === 0 && this.notchesSent === 0) return;
        this.onPipelineReport({
            frames: this.latencies.length,
            superseded: this.supersededFrames,
            p50Ms: percentile(this.latencies, 0.5),
            p95Ms: percentile(this.latencies, 0.95),
            bytesP95: percentile(this.frameBytes, 0.95),
            pixelsP95: percentile(this.framePixels, 0.95),
            notchesSent: this.notchesSent,
            notchesDropped: this.notchesDropped,
            notchesByFrame: this.notchesByFrame,
            notchesByTimer: this.notchesByTimer,
        });
        this.latencies.length = 0;
        this.frameBytes.length = 0;
        this.framePixels.length = 0;
        this.supersededFrames = 0;
        this.notchesSent = 0;
        this.notchesDropped = 0;
        this.notchesByFrame = 0;
        this.notchesByTimer = 0;
    }

    private enqueue(file: GraphicsFile): void {
        this.write(clientGraphicsStarted(file));
        const origin = file.leading.toString('base64');
        const replaced = this.pendingByOrigin.get(origin);
        if (replaced !== undefined) {
            // A valid Herdr 0.8.2 server permits one direct transfer at a time.
            // If a future/pipelined sender violates that gate, consume the stale
            // full frame exactly once and retain only the latest for this origin.
            const stale = this.admitted.get(replaced.transferId);
            if (stale !== undefined) stale.retired = true;
            this.admitted.delete(replaced.transferId);
            this.write(clientGraphicsResult(replaced, true));
            this.supersededFrames += 1;
        } else {
            this.pendingOrigins.push(origin);
        }
        this.pendingByOrigin.set(origin, file);
        this.bumpSourceQueueVersion(undefined, 'direct');
        this.admit(file);
        if (!this.draining) void this.drain();
    }

    private async drain(): Promise<void> {
        this.draining = true;
        try {
            while (!this.closed) {
                const origin = this.pendingOrigins.shift();
                if (origin !== undefined) {
                    const file = this.pendingByOrigin.get(origin);
                    if (file === undefined) continue;
                    this.pendingByOrigin.delete(origin);
                    await this.forward(file);
                    // Give one queued refinement a turn so a continuously
                    // streaming producer cannot starve the refine queue.
                    const queued = this.directRefineQueue.shift();
                    if (queued !== undefined) await this.refineDirect(queued);
                    continue;
                }
                const refinement = this.directRefineQueue.shift();
                if (refinement === undefined) return;
                await this.refineDirect(refinement);
            }
        } finally {
            this.draining = false;
            if (!this.closed && (this.pendingOrigins.length > 0 || this.directRefineQueue.length > 0)) void this.drain();
        }
    }

    private async forward(file: GraphicsFile): Promise<void> {
        const startedAt = Date.now();
        const admitted = this.admit(file);
        let acknowledged = false;
        try {
            // Herdr owns the leased file until success. Validate into a private
            // buffer first, then release its global direct-graphics gate before
            // routing, compression, layout probes, or phone delivery.
            const rgba = await readGraphicsFile(file);
            this.write(clientGraphicsResult(file, true));
            acknowledged = true;
            const paneId = await this.sourcePane(file.leading);
            if (this.shouldDrop(admitted, paneId)) return;
            const processReady = paneId !== undefined && await this.ensurePaneProcess(paneId);
            if (this.shouldDrop(admitted, paneId)) return;
            if (paneId !== undefined && processReady) this.noteSourceActivity(paneId);
            const prepared = !processReady || paneId === undefined ? undefined : await prepareKitty(
                rgba, file.control, this.allocateImageId(), file.transferId, this.halveFor(paneId),
            );
            if (this.shouldDrop(admitted, paneId)) return;
            if (paneId !== undefined && prepared !== undefined) {
                if (prepared.sourceWidth !== undefined) {
                    this.retainDirectRefinement(paneId, {
                        rgba,
                        control: file.control,
                        imageId: prepared.imageId,
                        transferId: file.transferId,
                        sourceImageId: file.imageId,
                    });
                } else {
                    this.dropDirectRefinement(paneId);
                }
                this.presentDirect(paneId, prepared, file.transferId, file.imageId, startedAt);
                if (prepared.sourceWidth !== undefined && this.directRawByPane.has(paneId) && !this.gestureActive(paneId)) {
                    this.armRefine(paneId, 'source');
                }
            }
        } catch (error) {
            this.logError(error);
        } finally {
            this.admitted.delete(file.transferId);
            // A consumed or rejected file must never disable the whole direct
            // client. write() is inert after shutdown.
            if (!acknowledged) this.write(clientGraphicsResult(file, true));
        }
    }

    private retainDirectRefinement(paneId: string, candidate: DirectRawFrame): void {
        this.dropDirectRefinement(paneId);
        if (candidate.rgba.length > MAX_REFINEMENT_BYTES
            || this.directRefinementBytes + candidate.rgba.length > MAX_REFINEMENT_BYTES) return;
        this.directRawByPane.set(paneId, candidate);
        this.directRefinementBytes += candidate.rgba.length;
    }

    private dropDirectRefinement(paneId: string): void {
        const candidate = this.directRawByPane.get(paneId);
        if (candidate === undefined) return;
        this.directRawByPane.delete(paneId);
        this.directRefinementBytes = Math.max(0, this.directRefinementBytes - candidate.rgba.length);
    }

    private async refineDirect(work: DirectRefineWork): Promise<void> {
        const { refinePane: paneId } = work;
        graphicsTrace?.add('refine.dequeue', { pane: paneId, path: 'direct', reason: work.reason });
        if (this.closed || !ADAPTIVE_DENSITY || this.gestureActive(paneId)) {
            graphicsTrace?.add('refine.reject', {
                pane: paneId, path: 'direct', why: this.closed ? 'closed' : this.gestureActive(paneId) ? 'gesture' : 'disabled', rearmed: false,
            });
            return;
        }
        if (!work.fenceRetry && work.sourceQueueVersion !== this.sourceQueueVersion) {
            // Another pane's traffic moved a shared counter. The rearm is fence
            // exempt, or a streaming neighbour can starve this pane forever.
            const rearmed = this.rearmAfterFenceLoss(paneId, work.sourceRevision);
            graphicsTrace?.add('refine.reject', {
                pane: paneId, path: 'direct', why: 'fence', rearmed,
                expected: work.sourceQueueVersion, actual: this.sourceQueueVersion,
                ...this.fenceProvenance(paneId),
            });
            return;
        }
        if (!this.sourceQuiet(paneId)) {
            const last = this.lastSourceAt.get(paneId) ?? Date.now();
            graphicsTrace?.add('refine.reject', { pane: paneId, path: 'direct', why: 'not-quiet', rearmed: true, quietForMs: Date.now() - last });
            this.armRefine(paneId, work.reason);
            return;
        }
        const raw = this.directRawByPane.get(paneId);
        const current = this.latestByPane.get(paneId);
        if (raw === undefined || current?.imageId !== raw.imageId || current.transferId !== raw.transferId
            || current.sourceWidth === undefined) {
            graphicsTrace?.add('refine.reject', { pane: paneId, path: 'direct', why: 'no-candidate', rearmed: false });
            return;
        }
        const prepareStartedAt = Date.now();
        let prepared: PreparedImage;
        try {
            prepared = await prepareKitty(raw.rgba, raw.control, raw.imageId, raw.transferId, false);
        } catch (error) {
            this.logError(error);
            graphicsTrace?.add('refine.reject', { pane: paneId, path: 'direct', why: 'prepare-failed', rearmed: false });
            return;
        }
        graphicsTrace?.add('refine.prepare', {
            pane: paneId, path: 'direct', durationMs: Date.now() - prepareStartedAt,
            width: prepared.width, height: prepared.height,
        });
        if (this.closed || !this.directRefinementCurrent(raw, paneId, work)) {
            const rearmed = !this.closed && this.rearmAfterFenceLoss(paneId, work.sourceRevision);
            graphicsTrace?.add('refine.reject', {
                pane: paneId, path: 'direct', why: this.closed ? 'closed' : 'stale-after-prepare', rearmed,
                ...this.fenceProvenance(paneId),
            });
            return;
        }
        this.dropDirectRefinement(paneId);
        this.presentDirect(paneId, prepared, raw.transferId, raw.sourceImageId, work.at);
    }

    private directRefinementCurrent(raw: DirectRawFrame, paneId: string, work: DirectRefineWork): boolean {
        const current = this.directRawByPane.get(paneId);
        return current === raw
            && (this.sourceRevision.get(paneId) ?? 0) === work.sourceRevision
            && (work.fenceRetry || this.sourceQueueVersion === work.sourceQueueVersion)
            && !this.gestureActive(paneId);
    }

    private presentDirect(
        paneId: string,
        prepared: PreparedImage,
        transferId: bigint,
        sourceImageId: number,
        startedAt: number,
    ): void {
        const previous = this.latestByPane.get(paneId);
        // Replace exactly the image the phone is showing. The frame is parsed
        // atomically, so the delete and the new placement land together; a
        // clear-all would also erase unrelated placements the bridge still owes
        // to late subscribers.
        const clear = previous === undefined || previous.imageId === prepared.imageId
            ? 'none' as const
            : { imageId: previous.imageId };
        if (previous !== undefined) this.imageOwners.delete(previous.transferId);
        this.latestByPane.set(paneId, prepared);
        this.imageOwners.set(transferId, { paneId, imageId: prepared.imageId, sourceImageId });
        for (const registration of this.registrations.values()) {
            if (registration.paneId !== paneId) continue;
            const frame = terminalFrame(encodeKitty(prepared, registration, clear), registration, true);
            graphicsTrace?.frame('frame.handoff', frame, {
                pane: paneId, path: 'direct', sharp: prepared.sourceWidth === undefined,
                width: prepared.width, height: prepared.height, sinceRoutedMs: Date.now() - startedAt,
            });
            registration.write(frame);
            this.recordFrame(startedAt, frame.length, prepared.width * prepared.height);
        }
        this.drainNotch(paneId, 'frame');
    }

    private admit(file: GraphicsFile): AdmittedTransfer {
        const existing = this.admitted.get(file.transferId);
        if (existing !== undefined) return existing;
        const record: AdmittedTransfer = {
            sourceImageId: file.imageId,
            generation: this.nextGeneration,
            retired: false,
        };
        this.admitted.set(file.transferId, record);
        return record;
    }

    private shouldDrop(admitted: AdmittedTransfer, paneId?: string): boolean {
        if (paneId !== undefined) admitted.paneId = paneId;
        if (this.closed) return true;
        const retiredAt = admitted.paneId === undefined ? 0 : (this.paneRetiredGeneration.get(admitted.paneId) ?? 0);
        if (retiredAt > admitted.generation) return true;
        // A retired lease only invalidates the in-flight frame, never the
        // pixels the phone already shows: the replacement (or the program's own
        // explicit delete, or the pane process dying) decides what is on screen
        // next. Clearing here blanked the pane between every repaint.
        return admitted.retired;
    }

    /** The pane's foreground process is gone; nothing on the phone survives. */
    private emitPaneClear(paneId: string): void {
        this.clearScrollState(paneId);
        this.latestByPane.delete(paneId);
        this.dropDirectRefinement(paneId);
        this.cancelRefine(paneId);
        this.bumpSourceQueueVersion(paneId, 'clear');
        this.lastSourceAt.delete(paneId);
        this.lastInputAt.delete(paneId);
        this.sourceRevision.delete(paneId);
        for (const [transferId, owner] of this.imageOwners) {
            if (owner.paneId === paneId) this.imageOwners.delete(transferId);
        }
        const bytes = Buffer.from('\u001b7\u001b_Ga=d,d=A,q=2;\u001b\\\u001b8');
        for (const registration of this.registrations.values()) {
            if (registration.paneId === paneId) registration.write(terminalFrame(bytes, registration, false));
        }
    }

    private allocateImageId(): number {
        const used = new Set([...this.imageOwners.values()].map((owner) => owner.imageId));
        for (const image of this.latestByPane.values()) used.add(image.imageId);
        while (used.has(this.nextImageId)) this.nextImageId = this.nextImageId % 0x7fffffff + 1;
        const result = this.nextImageId;
        this.nextImageId = this.nextImageId % 0x7fffffff + 1;
        return result;
    }

    private retire(transferId: bigint, sourceImageId: number): void {
        const admitted = this.admitted.get(transferId);
        if (admitted !== undefined && admitted.sourceImageId === sourceImageId) admitted.retired = true;
        const owner = this.imageOwners.get(transferId);
        if (owner === undefined || owner.sourceImageId !== sourceImageId) return;
        // The lease is gone but the phone still shows the delivered pixels, so
        // the pane's current image keeps its owner record: the successor's
        // frame deletes exactly this image id, a late subscriber is replayed
        // what is on screen, an explicit program delete still translates
        // Herdr's source id to the id the phone holds, and scroll takeover
        // does not drop mid-gesture. Only noncurrent owners are released.
        const latest = this.latestByPane.get(owner.paneId);
        if (latest?.transferId === transferId) return;
        this.imageOwners.delete(transferId);
    }

    private async ensurePaneProcess(paneId: string): Promise<boolean> {
        if (this.paneProcessGroups.has(paneId)) return true;
        if (this.processProbeAttempted.has(paneId)) return false;
        const processGroup = await this.foregroundProcessGroup(paneId);
        if (processGroup === undefined) {
            const failures = (this.processProbeFailures.get(paneId) ?? 0) + 1;
            this.processProbeFailures.set(paneId, failures);
            if (failures >= 3) this.processProbeAttempted.add(paneId);
            this.logError(new Error(`could not verify graphics process for pane ${paneId}`));
            return false;
        }
        this.paneProcessGroups.set(paneId, processGroup);
        this.processProbeFailures.delete(paneId);
        this.startProcessMonitor();
        return true;
    }

    private logError(error: unknown): void {
        if (Date.now() - this.lastErrorAt < 5000) return;
        this.lastErrorAt = Date.now();
        process.stderr.write(`terminal graphics: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    private startProcessMonitor(): void {
        if (this.processTimer !== undefined) return;
        this.processTimer = setInterval(() => { void this.pollProcesses(); }, 1000);
        this.processTimer.unref();
    }

    private async pollProcesses(): Promise<void> {
        if (this.pollingProcesses || this.closed) return;
        this.pollingProcesses = true;
        try {
            for (const [paneId, expected] of [...this.paneProcessGroups]) {
                const current = await this.foregroundProcessGroup(paneId);
                if (current === undefined) {
                    const failures = (this.processProbeFailures.get(paneId) ?? 0) + 1;
                    this.processProbeFailures.set(paneId, failures);
                    if (failures >= 3) this.retirePane(paneId);
                } else if (current !== expected) {
                    this.retirePane(paneId);
                } else {
                    this.processProbeFailures.delete(paneId);
                }
            }
            if (this.paneProcessGroups.size === 0 && this.processTimer !== undefined) {
                clearInterval(this.processTimer);
                this.processTimer = undefined;
            }
        } finally {
            this.pollingProcesses = false;
        }
    }

    private async foregroundProcessGroup(paneId: string): Promise<number | undefined> {
        try {
            const { stdout } = await run(this.herdrBin, ['pane', 'process-info', '--pane', paneId], { timeout: 3000 });
            const value = JSON.parse(stdout) as { result?: { process_info?: { foreground_process_group_id?: number } } };
            const processGroup = value.result?.process_info?.foreground_process_group_id;
            return Number.isSafeInteger(processGroup) ? processGroup : undefined;
        } catch {
            return undefined;
        }
    }

    private retirePane(paneId: string): void {
        this.nextGeneration += 1;
        this.paneRetiredGeneration.set(paneId, this.nextGeneration);
        for (const work of this.admitted.values()) {
            if (work.paneId === paneId) work.retired = true;
        }
        this.paneProcessGroups.delete(paneId);
        this.processProbeAttempted.delete(paneId);
        this.processProbeFailures.delete(paneId);
        this.emitPaneClear(paneId);
    }

    private async sourcePane(leading: Buffer): Promise<string | undefined> {
        const match = /^\u001b\[(\d+);(\d+)H$/.exec(leading.toString('utf8'));
        if (match === null) return undefined;
        const paneIds = new Set([...this.registrations.values()].map((item) => item.paneId));
        const routes = await Promise.all([...paneIds].map(async (paneId): Promise<GraphicsRoute> => {
            const rect = await this.visibleRect(paneId);
            return { paneId, ...(rect === undefined ? {} : { rect }) };
        }));
        return routeGraphicsPane(leading, routes);
    }

    private async visibleRect(paneId: string): Promise<Rect | undefined> {
        return (await this.paneVisibility(paneId))?.rect;
    }

    private paneVisibility(paneId: string): Promise<PaneVisibility | undefined> {
        const cached = this.layoutCache.get(paneId);
        if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
        const value = this.loadPaneVisibility(paneId);
        this.layoutCache.set(paneId, { expiresAt: Date.now() + LAYOUT_CACHE_MS, value });
        return value;
    }

    /**
     * Tells a pane that Herdr is not rendering it, once, and never guesses.
     * Only an answered lookup that says the pane is off the active surface
     * speaks: a slow frame, a failed `herdr` call or an unparsable layout all
     * leave the phone exactly as it was. Graphics ending here is honest --
     * nothing is arriving -- and it hands scrolling and pointer input back to
     * the text the pane is still producing.
     */
    private async announceOffSurfacePanes(): Promise<void> {
        if (this.closed) return;
        const paneIds = new Set([...this.registrations.values()].map((item) => item.paneId));
        for (const paneId of this.offSurfacePanes) {
            if (!paneIds.has(paneId)) this.offSurfacePanes.delete(paneId);
        }
        for (const paneId of paneIds) {
            const visibility = await this.paneVisibility(paneId);
            if (this.closed || visibility === undefined) continue;
            if (visibility.onActiveSurface) { this.offSurfacePanes.delete(paneId); continue; }
            if (this.offSurfacePanes.has(paneId)) continue;
            this.offSurfacePanes.add(paneId);
            for (const registration of this.registrations.values()) {
                if (registration.paneId !== paneId) continue;
                registration.write(terminalFrame(Buffer.alloc(0), registration, false, 'pane-off-surface'));
            }
        }
    }

    private async activeWorkspace(): Promise<{ workspaceId: string; tabId: string } | undefined> {
        const cached = this.workspaceCache;
        if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
        const value = run(this.herdrBin, ['workspace', 'list'], { timeout: 3000 })
            .then(({ stdout }) => {
                const parsed = JSON.parse(stdout) as { result?: { workspaces?: {
                    workspace_id?: string;
                    active_tab_id?: string;
                    focused?: boolean;
                }[] } };
                const active = parsed.result?.workspaces?.find((item) => item.focused === true);
                return active?.workspace_id === undefined || active.active_tab_id === undefined
                    ? undefined
                    : { workspaceId: active.workspace_id, tabId: active.active_tab_id };
            })
            .catch(() => undefined);
        this.workspaceCache = { expiresAt: Date.now() + LAYOUT_CACHE_MS, value };
        return value;
    }

    private async loadPaneVisibility(paneId: string): Promise<PaneVisibility | undefined> {
        try {
            const [active, { stdout: layoutRaw }] = await Promise.all([
                this.activeWorkspace(),
                run(this.herdrBin, ['pane', 'layout', '--pane', paneId], { timeout: 3000 }),
            ]);
            const layout = JSON.parse(layoutRaw) as { result?: { layout?: {
                workspace_id?: string;
                tab_id?: string;
                focused_pane_id?: string;
                zoomed?: boolean;
                area?: Rect;
                panes?: { pane_id?: string; rect?: Rect }[];
            } } };
            const value = layout.result?.layout;
            // An unanswered lookup is ignorance, not absence: say nothing.
            if (value === undefined || active === undefined) return undefined;
            if (active.workspaceId !== value.workspace_id || active.tabId !== value.tab_id) return { onActiveSurface: false };
            if (value.zoomed === true) {
                // A zoomed tab renders only its focused pane, so every other
                // pane on it is as invisible as one in another workspace.
                return value.focused_pane_id === paneId && value.area !== undefined
                    ? { rect: value.area, onActiveSurface: true }
                    : { onActiveSurface: false };
            }
            // A pane always appears in its own tab's layout, so a missing rect
            // here is a fixture or a version we do not understand -- ignorance,
            // not absence. The two ways a pane is genuinely not rendered are
            // both explicit above: another workspace or tab, and a zoomed tab.
            const rect = value.panes?.find((pane) => pane.pane_id === paneId)?.rect;
            return rect === undefined ? undefined : { rect, onActiveSurface: true };
        } catch {
            return undefined;
        }
    }
}

export function graphicsPlacement(image: PreparedImage, target: HerdrGraphicsRegistration): GraphicsPlacement {
    const cellAspect = target.cellWidthPx / target.cellHeightPx;
    let cols = target.cols;
    let rows = Math.max(1, Math.round(image.height / image.width * cols * cellAspect));
    if (rows > target.rows) {
        rows = target.rows;
        cols = Math.max(1, Math.round(image.width / image.height * rows / cellAspect));
    }
    return {
        cols,
        rows,
        row: Math.max(0, Math.floor((target.rows - rows) / 2)),
        col: Math.max(0, Math.floor((target.cols - cols) / 2)),
    };
}

/** Deletes carry no position; keep the phone's cursor where it was. */
function wrapAtOrigin(bytes: Buffer): Buffer {
    return Buffer.concat([Buffer.from('\u001b7'), bytes, Buffer.from('\u001b8')]);
}

export function mapGraphicsPointer(
    image: PreparedImage,
    target: HerdrGraphicsRegistration,
    pointer: HerdrGraphicsPointer,
): { x: number; y: number } | undefined {
    if (!validPointer(pointer)) return undefined;
    const placement = graphicsPlacement(image, target);
    const gridWidth = target.cols * target.cellWidthPx;
    const gridHeight = target.rows * target.cellHeightPx;
    const x = pointer.x * (gridWidth / pointer.width);
    const y = pointer.y * (gridHeight / pointer.height);
    const left = placement.col * target.cellWidthPx;
    const top = placement.row * target.cellHeightPx;
    const width = placement.cols * target.cellWidthPx;
    const height = placement.rows * target.cellHeightPx;
    if (x < left || x > left + width || y < top || y > top + height) return undefined;
    // Injected reports bypass Herdr's desktop encoder and must match the
    // producer's SGR-pixel mode: 1-based source-image pixels.
    // Against the producer's own pixels: a transmitted image that was halved
    // would otherwise report every gesture at half the position it happened.
    const sourceWidth = image.sourceWidth ?? image.width;
    const sourceHeight = image.sourceHeight ?? image.height;
    return {
        x: Math.max(1, Math.min(sourceWidth, Math.round((x - left) / width * sourceWidth))),
        y: Math.max(1, Math.min(sourceHeight, Math.round((y - top) / height * sourceHeight))),
    };
}

export function routeGraphicsPane(leading: Buffer, routes: readonly GraphicsRoute[]): string | undefined {
    const match = /^\u001b\[(\d+);(\d+)H$/.exec(leading.toString('utf8'));
    if (match === null) return undefined;
    const row = Number(match[1]) - 1;
    const col = Number(match[2]) - 1;
    const matches = routes.filter(({ rect }) => rect !== undefined
        && col >= rect.x && col < rect.x + rect.width
        && row >= rect.y && row < rect.y + rect.height);
    return matches.length === 1 ? matches[0]?.paneId : undefined;
}

async function appGeometry(herdrBin: string, cellWidthPx: number, cellHeightPx: number): Promise<AppGeometry> {
    const { stdout: panesRaw } = await run(herdrBin, ['pane', 'list'], { timeout: 3000 });
    const panes = JSON.parse(panesRaw) as { result?: { panes?: { pane_id?: string; focused?: boolean }[] } };
    const paneId = panes.result?.panes?.find((pane) => pane.focused === true)?.pane_id;
    if (paneId === undefined) throw new Error('Herdr has no focused pane for graphics geometry');
    const { stdout: layoutRaw } = await run(herdrBin, ['pane', 'layout', '--pane', paneId], { timeout: 3000 });
    const layout = JSON.parse(layoutRaw) as { result?: { layout?: { area?: Rect; panes?: { rect?: Rect }[] } } };
    const rects = [layout.result?.layout?.area, ...(layout.result?.layout?.panes ?? []).map((pane) => pane.rect)]
        .filter((rect): rect is Rect => rect !== undefined);
    const cols = Math.max(0, ...rects.map((rect) => rect.x + rect.width));
    const rows = Math.max(0, ...rects.map((rect) => rect.y + rect.height));
    const geometry = { cols, rows, cellWidthPx, cellHeightPx };
    if (![cols, rows, cellWidthPx, cellHeightPx].every((value) => Number.isFinite(value) && value > 0 && value <= 1000)) {
        throw new Error('invalid Herdr graphics geometry');
    }
    return geometry;
}

function validRegistration(value: HerdrGraphicsRegistration): boolean {
    return value.channel !== '' && value.paneId !== ''
        && [value.cols, value.rows, value.cellWidthPx, value.cellHeightPx].every((number) => Number.isFinite(number) && number > 0)
        && value.cols <= 1000 && value.rows <= 1000 && value.cellWidthPx <= 1000 && value.cellHeightPx <= 1000;
}

function validPointer(value: HerdrGraphicsPointer): boolean {
    return [value.x, value.y, value.width, value.height].every(Number.isFinite)
        && value.width > 0 && value.height > 0;
}

function frame(payload: Buffer): Buffer {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(payload.length);
    return Buffer.concat([length, payload]);
}

function uint(value: number | bigint): Buffer {
    const number = BigInt(value);
    if (number < 251n) return Buffer.from([Number(number)]);
    if (number <= 0xffffn) { const data = Buffer.allocUnsafe(3); data[0] = 251; data.writeUInt16LE(Number(number), 1); return data; }
    if (number <= 0xffffffffn) { const data = Buffer.allocUnsafe(5); data[0] = 252; data.writeUInt32LE(Number(number), 1); return data; }
    const data = Buffer.allocUnsafe(9); data[0] = 253; data.writeBigUInt64LE(number, 1); return data;
}

function clientHello(geometry: AppGeometry): Buffer {
    return Buffer.concat([uint(0), uint(PROTOCOL_VERSION), uint(geometry.cols), uint(geometry.rows),
        uint(geometry.cellWidthPx), uint(geometry.cellHeightPx), uint(1), uint(0), uint(1)]);
    // TerminalAnsi, server keybindings, AppDirectGraphics
}
function clientDetach(): Buffer { return uint(4); }
function clientGraphicsResult(file: GraphicsFile, success: boolean): Buffer {
    return Buffer.concat([uint(10), uint(file.transferId), uint(file.imageId), Buffer.from([success ? 1 : 0])]);
}
function clientGraphicsStarted(file: GraphicsFile): Buffer {
    return Buffer.concat([uint(12), uint(file.transferId), uint(file.imageId)]);
}

class Reader {
    private offset = 0;
    constructor(private readonly value: Buffer) {}
    uint(): bigint {
        const prefix = this.value[this.offset++];
        if (prefix === undefined) throw new Error('truncated bincode integer');
        if (prefix <= 250) return BigInt(prefix);
        if (prefix === 251) { const result = this.value.readUInt16LE(this.offset); this.offset += 2; return BigInt(result); }
        if (prefix === 252) { const result = this.value.readUInt32LE(this.offset); this.offset += 4; return BigInt(result); }
        if (prefix === 253) { const result = this.value.readBigUInt64LE(this.offset); this.offset += 8; return result; }
        throw new Error('unsupported bincode integer');
    }
    number(): number { return Number(this.uint()); }
    boolean(): boolean { return this.byte() !== 0; }
    byte(): number { const result = this.value[this.offset++]; if (result === undefined) throw new Error('truncated bincode byte'); return result; }
    bytes(): Buffer { const length = this.number(); const result = this.value.subarray(this.offset, this.offset + length); if (result.length !== length) throw new Error('truncated bincode bytes'); this.offset += length; return result; }
    string(): string { return this.bytes().toString('utf8'); }
    option<T>(read: () => T): T | undefined { return this.byte() === 0 ? undefined : read(); }
}

export function decodeServerMessage(payload: Buffer): ServerMessage {
    const reader = new Reader(payload);
    switch (reader.number()) {
        case 0: {
            const version = reader.number();
            reader.number();
            const error = reader.option(() => reader.string());
            return { type: 'welcome', version, ...(error === undefined ? {} : { error }) };
        }
        case 1: return { type: 'other' };
        case 2: {
            reader.uint(); reader.number(); reader.number(); reader.boolean();
            return { type: 'output', bytes: reader.bytes() };
        }
        case 3: return { type: 'graphics', bytes: reader.bytes() };
        case 4: reader.option(() => reader.string()); return { type: 'closed' };
        case 5: reader.number(); reader.string(); reader.option(() => reader.string()); return { type: 'other' };
        case 6: reader.string(); return { type: 'other' };
        case 7: reader.option(() => reader.string()); return { type: 'other' };
        case 8: return { type: 'other' };
        case 9: reader.boolean(); reader.boolean(); return { type: 'other' };
        case 10: reader.boolean(); return { type: 'other' };
        case 11: reader.boolean(); return { type: 'other' };
        case 12: reader.number(); return { type: 'other' };
        case 13: {
            const path = reader.string();
            const expectedLength = reader.uint();
            const imageId = reader.number();
            const transferId = reader.uint();
            const leading = reader.bytes();
            const control = reader.string();
            return { type: 'graphics-file', file: { path, expectedLength, imageId, transferId, leading, control } };
        }
        case 14: return { type: 'retired', transferId: reader.uint(), imageId: reader.number() };
        default: throw new Error('unknown Herdr server message');
    }
}

/**
 * Clear the pane's images and tell the client direct graphics stopped. Used both
 * when a live bridge shuts down and when one never opened at all.
 */
export function graphicsStoppedFrame(cols: number, rows: number, reason?: TerminalGraphicsReason): string {
    const clear = Buffer.from('\u001b7\u001b_Ga=d,d=A,q=2;\u001b\\\u001b8');
    return terminalFrame(clear, { cols, rows }, false, reason);
}

function terminalFrame(
    bytes: Buffer,
    target: Pick<HerdrGraphicsRegistration, 'cols' | 'rows'>,
    graphics?: boolean,
    graphicsReason?: TerminalGraphicsReason,
): string {
    return JSON.stringify({ type: 'terminal.frame', seq: 0, encoding: 'ansi', width: target.cols, height: target.rows,
        full: false, bytes: bytes.toString('base64'), ...(graphics === undefined ? {} : { graphics }),
        ...(graphicsReason === undefined ? {} : { graphicsReason }) });
}

async function readGraphicsFile(file: GraphicsFile): Promise<Buffer> {
    const length = Number(file.expectedLength);
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_IMAGE_BYTES) {
        const control = file.control.length > 96 ? `${file.control.slice(0, 96)}...` : file.control;
        throw new Error(`invalid graphics length expectedLength=${file.expectedLength} control=${control}`);
    }
    const handle = await open(file.path, 'r');
    try {
        const before = await handle.stat();
        if (before.size !== length) throw new Error('graphics file changed');
        const rgba = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(rgba, 0, length, 0);
        const after = await handle.stat();
        if (bytesRead !== length || after.size !== length) throw new Error('graphics file changed');
        return rgba;
    } finally {
        await handle.close();
    }
}

async function prepareKitty(rgba: Buffer, control: string, imageId: number, transferId: bigint, halve: boolean): Promise<PreparedImage> {
    const width = Number(/(?:^|,)s=(\d+)/.exec(control)?.[1]);
    const height = Number(/(?:^|,)v=(\d+)/.exec(control)?.[1]);
    const sourceImageId = Number(/(?:^|,)i=(\d+)/.exec(control)?.[1]);
    if (![width, height, sourceImageId].every(Number.isFinite) || width <= 0 || height <= 0
        || width * height * 4 !== rgba.length) {
        throw new Error('invalid Herdr graphics control');
    }
    // A moving producer frame is coarse; after input and source quiet the same
    // pixels are prepared again at their own density. Kitty c/r are cell counts
    // and graphicsPlacement refits by aspect ratio, so only density changes.
    // Small images are left exact: an icon beside a plot has no density to spare.
    const scaled = halve && rgba.length > COMPRESS_HARDER_BYTES
        ? halveRgba(rgba, width, height) : undefined;
    const pixels = scaled?.rgba ?? rgba;
    // Every byte of this frame is decrypted in JavaScript on the phone, so a
    // large image is worth real compression; a small one is not worth the wait.
    const level = pixels.length > COMPRESS_HARDER_BYTES ? 6 : 1;
    return {
        compressed: await compress(pixels, { level }),
        width: scaled?.width ?? width,
        height: scaled?.height ?? height,
        imageId,
        transferId,
        ...(scaled === undefined ? {} : { sourceWidth: width, sourceHeight: height }),
    };
}

/**
 * Box-filtered halving: each output pixel is the average of the 2x2 block it
 * covers. Nearest-neighbour would be cheaper, but this is a page of text and
 * dropping every other row of a glyph stem is exactly the aliasing a reader
 * sees. An odd final column or row has only one source pixel to average, so it
 * is carried through as itself rather than read past the end of the buffer.
 */
function halveRgba(rgba: Buffer, width: number, height: number): { rgba: Buffer; width: number; height: number } {
    const outWidth = Math.ceil(width / 2);
    const outHeight = Math.ceil(height / 2);
    const out = Buffer.allocUnsafe(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y += 1) {
        const y0 = y * 2;
        const y1 = y0 + 1 < height ? y0 + 1 : y0;
        for (let x = 0; x < outWidth; x += 1) {
            const x0 = x * 2;
            const x1 = x0 + 1 < width ? x0 + 1 : x0;
            const a = (y0 * width + x0) * 4;
            const b = (y0 * width + x1) * 4;
            const c = (y1 * width + x0) * 4;
            const d = (y1 * width + x1) * 4;
            const at = (y * outWidth + x) * 4;
            for (let channel = 0; channel < 4; channel += 1) {
                out[at + channel] = (rgba[a + channel]! + rgba[b + channel]! + rgba[c + channel]! + rgba[d + channel]! + 2) >> 2;
            }
        }
    }
    return { rgba: out, width: outWidth, height: outHeight };
}

/** Bounded sample window: an account of the recent past, never a history. */
function push(samples: number[], value: number): void {
    samples.push(value);
    if (samples.length > 256) samples.shift();
}

function percentile(samples: readonly number[], fraction: number): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return Math.round(sorted[index]!);
}

/**
 * One self-contained frame: an optional delete of exactly what this image
 * replaces, the pixels, and the placement.
 *
 * `clear` is deliberately narrow. Deleting everything on every frame is what
 * makes a second image in the same pane -- a legend beside a plot, an icon
 * above a prompt -- impossible, so it happens only when a pane is being reset.
 */
export function encodeKitty(
    image: PreparedImage,
    target: HerdrGraphicsRegistration,
    clear: 'all' | 'none' | { imageId: number },
): Buffer {
    const encoded = image.compressed.toString('base64');
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK_CHARS) chunks.push(encoded.slice(offset, offset + KITTY_CHUNK_CHARS));
    const { row, col, cols, rows } = graphicsPlacement(image, target);
    const placementId = image.imageId & 0x7fffffff;
    const output: Buffer[] = [Buffer.from('\u001b7')];
    if (clear === 'all') output.push(Buffer.from('\u001b_Ga=d,d=A,q=2;\u001b\\'));
    else if (clear !== 'none') output.push(Buffer.from(`\u001b_Ga=d,d=I,i=${clear.imageId},q=2;\u001b\\`));
    output.push(Buffer.from(`\u001b[${row + 1};${col + 1}H`));
    chunks.forEach((chunk, index) => {
        const more = index < chunks.length - 1 ? 1 : 0;
        const header = index === 0
            ? `a=T,f=32,s=${image.width},v=${image.height},i=${image.imageId},p=${placementId},c=${cols},r=${rows},z=0,C=1,q=2,t=d,o=z,m=${more}`
            : `m=${more}`;
        output.push(Buffer.from(`\u001b_G${header};${chunk}\u001b\\`));
    });
    output.push(Buffer.from('\u001b8'));
    return Buffer.concat(output);
}
