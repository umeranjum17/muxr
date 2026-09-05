import { execFile } from 'node:child_process';
import { InlineImageStore, InlineKittyScanner, type InlineKittyBlock } from './inlineKitty.js';
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
/** Images a pane may keep on a phone at once: a plot, its legend, an icon. */
const MAX_LIVE_PLACEMENTS = 16;
/** Deflate harder once a frame is large: the phone decrypts every byte in JS. */
const COMPRESS_HARDER_BYTES = 512 * 1024;
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
};

type ImageOwner = { paneId: string; imageId: number; sourceImageId: number };
type AdmittedTransfer = {
    sourceImageId: number;
    generation: number;
    retired: boolean;
    cleared: boolean;
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

/** Frames a producer emitted for one pane, newest first in effect. */
type InlineWork = { block: InlineKittyBlock; at: number };

/** What a pane is currently showing, keyed by Herdr's own placement key. */
type LivePlacement = { image: PreparedImage; block: InlineKittyBlock; surface: GraphicsSurface };

/** Whether an image is the pane's whole surface or sits inside its text. */
export type GraphicsSurface = 'full' | 'inline';

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
    private readonly layoutCache = new Map<string, { expiresAt: number; value: Promise<Rect | undefined> }>();
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
    private readonly inlineImages = new InlineImageStore();
    /** Last inline placement forwarded per placement, so repaints are not resent. */
    private readonly inlinePlaced = new Map<string, string>();
    /** Every image a pane currently shows, so a late phone sees all of them. */
    private readonly livePlacements = new Map<string, Map<string, LivePlacement>>();
    /** Notches a pane has yet to answer, and the intent still owed to it. */
    private readonly scrollInFlight = new Map<string, number>();
    private readonly scrollBacklog = new Map<string, ScrollIntent>();
    private readonly scrollTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * Producer frames wait here in arrival order. Only one is prepared at a
     * time and any placement a newer one supersedes is dropped before it costs
     * a layout probe, a decode, or a compression.
     */
    private readonly inlineQueue: InlineWork[] = [];
    private inlineDraining = false;
    private readonly latencies: number[] = [];
    private readonly frameBytes: number[] = [];
    private readonly framePixels: number[] = [];
    private supersededFrames = 0;
    private notchesSent = 0;
    private notchesDropped = 0;
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
        if (onPipelineReport !== undefined) {
            this.reportTimer = setInterval(() => { this.reportPipeline(); }, PIPELINE_REPORT_MS);
            this.reportTimer.unref();
        }
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
        // A phone joining late is owed everything the pane is showing, not just
        // the last image to arrive.
        const live = this.livePlacements.get(registration.paneId);
        if (live !== undefined && live.size > 0) {
            for (const placement of live.values()) {
                registration.write(terminalFrame(
                    encodeKitty(placement.image, registration, 'none', placement.block, undefined, placement.surface),
                    registration,
                    true,
                    undefined,
                    placement.surface,
                ));
            }
            return true;
        }
        const latest = this.latestByPane.get(registration.paneId);
        if (latest !== undefined) {
            registration.write(terminalFrame(encodeKitty(latest, registration, 'all'), registration, true, undefined, 'full'));
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
        return (this.livePlacements.get(registration.paneId)?.size ?? 0) > 0
            || this.latestByPane.has(registration.paneId);
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
        const image = this.latestByPane.get(paneId) ?? [...(this.livePlacements.get(paneId)?.values() ?? [])].pop()?.image;
        if (image === undefined) return [];
        const point = at === undefined ? { x: Math.ceil(image.width / 2), y: Math.ceil(image.height / 2) }
            : mapGraphicsPointer(image, registration, { ...at, phase: 'move' });
        if (point === undefined) return [];
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
        this.notchesSent += now;
        return Array.from({ length: now }, () => report);
    }

    /** One notch of the remaining gesture, released by a delivered frame. */
    private drainNotch(paneId: string): void {
        const inFlight = this.scrollInFlight.get(paneId) ?? 0;
        const backlog = this.scrollBacklog.get(paneId);
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
        this.notchesSent += 1;
        this.armNotchFallback(paneId);
    }

    /** A program that never repaints must still scroll, just not unboundedly. */
    private armNotchFallback(paneId: string): void {
        const existing = this.scrollTimers.get(paneId);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.scrollTimers.delete(paneId);
            if (this.closed) return;
            this.drainNotch(paneId);
        }, NOTCH_FALLBACK_MS);
        timer.unref();
        this.scrollTimers.set(paneId, timer);
    }

    private clearScrollState(paneId: string): void {
        this.scrollInFlight.delete(paneId);
        this.scrollBacklog.delete(paneId);
        const timer = this.scrollTimers.get(paneId);
        if (timer !== undefined) clearTimeout(timer);
        this.scrollTimers.delete(paneId);
    }

    private wheelReport(paneId: string, direction: 'up' | 'down', point: ScrollPoint): Buffer | undefined {
        const image = this.latestByPane.get(paneId)
            ?? [...(this.livePlacements.get(paneId)?.values() ?? [])].pop()?.image;
        if (image === undefined) return undefined;
        const button = direction === 'up' ? 64 : 65;
        const x = Math.max(1, Math.min(image.width, point.x));
        const y = Math.max(1, Math.min(image.height, point.y));
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
        try { if (this.socket.writable) this.socket.write(frame(clientDetach())); } catch { /* socket already closed */ }
        this.closed = true;
        const clear = Buffer.from('\u001b7\u001b_Ga=d,d=A,q=2;\u001b\\\u001b8');
        for (const registration of this.registrations.values()) {
            registration.write(terminalFrame(clear, registration, false, reason));
        }
        this.registrations.clear();
        this.latestByPane.clear();
        this.imageOwners.clear();
        this.pendingByOrigin.clear();
        this.pendingOrigins.length = 0;
        this.layoutCache.clear();
        this.paneProcessGroups.clear();
        this.processProbeAttempted.clear();
        this.processProbeFailures.clear();
        this.admitted.clear();
        this.paneRetiredGeneration.clear();
        this.inlineQueue.length = 0;
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
                this.retire(message.transferId, message.imageId);
                this.shutdown('retired');
            } else if (message.type === 'closed') {
                this.close();
            }
        }
    }

    /**
     * Herdr writes a program's own Kitty images into the app output stream,
     * positioned by the cursor. Pixels are transmitted once per image and
     * placed separately, and a program transmits long before a phone attaches,
     * so image data is always learned; only placements need a live pane.
     *
     * Scanning is synchronous so arrival order is preserved; the work itself is
     * drained by one worker, because a producer repainting an animation emits
     * frames far faster than a phone can be given them.
     */
    private queueInline(bytes: Buffer): void {
        if (this.closed) return;
        const at = Date.now();
        for (const block of this.inlineScanner.scan(bytes)) {
            if (this.inlineImages.admit(block)) continue;
            if (this.registrations.size === 0) continue;
            const action = block.keys.a ?? 'p';
            if (action !== 'd' && action !== 'p' && action !== 'T') continue;
            this.inlineQueue.push({ block, at });
        }
        if (!this.inlineDraining) void this.drainInline();
    }

    private async drainInline(): Promise<void> {
        this.inlineDraining = true;
        try {
            while (!this.closed) {
                const work = this.inlineQueue.shift();
                if (work === undefined) return;
                await this.forwardInlineBlock(work);
            }
        } finally {
            this.inlineDraining = false;
            if (!this.closed && this.inlineQueue.length > 0) void this.drainInline();
        }
    }

    private async forwardInlineBlock(work: InlineWork): Promise<void> {
        const { block, at } = work;
        const action = block.keys.a ?? 'p';
        // A program's own delete carries Herdr's image id, which is the id the
        // phone holds, so it is forwarded verbatim and in order. Deletes are
        // never superseded: dropping one leaves an image on screen forever.
        if (action === 'd') {
            this.forgetPlacements(block);
            for (const registration of this.registrations.values()) {
                registration.write(terminalFrame(wrapAtOrigin(block.bytes), registration, false));
            }
            return;
        }
        const key = placementKey(block);
        if (key === undefined) return;
        // Newest wins, per placement. A repaint of this surface makes this frame
        // worthless, and it is dropped before it costs a layout probe, a base64
        // decode, or a compression -- but a second image elsewhere in the pane
        // is not a repaint of this one, and survives.
        if (this.superseded(key)) return;
        const paneId = await this.sourcePane(cursorAt(block));
        if (paneId === undefined || this.closed || this.superseded(key)) return;
        // A repainting producer re-places the same image many times a
        // second; only a changed placement is worth a phone frame.
        const identity = `${paneId}:${key}:${block.bytes.toString('base64')}`;
        if (this.inlinePlaced.get(`${paneId}:${key}`) === identity) return;
        const imageId = Number(block.keys.i ?? block.keys.I);
        const image = await this.inlineImages.prepared(block, (rgba, control) => prepareKitty(
            rgba, control, Number.isSafeInteger(imageId) && imageId > 0 ? imageId : this.allocateImageId(), 0n,
        ));
        if (image === undefined || this.closed || this.superseded(key)) return;
        const rect = await this.visibleRect(paneId);
        if (this.closed || this.superseded(key)) return;
        const surface = surfaceOf(block, rect);
        const live = this.placementsFor(paneId);
        const previous = live.get(key);
        live.set(key, { image, block, surface });
        if (live.size > MAX_LIVE_PLACEMENTS) {
            const oldest = live.keys().next().value;
            if (oldest !== undefined && oldest !== key) live.delete(oldest);
        }
        this.inlinePlaced.set(`${paneId}:${key}`, identity);
        if (surface === 'full') this.latestByPane.set(paneId, image);
        for (const registration of this.registrations.values()) {
            if (registration.paneId !== paneId) continue;
            const bytes = encodeKitty(image, registration, replaced(previous, image), block, rect, surface);
            const frame = terminalFrame(bytes, registration, true, undefined, surface);
            registration.write(frame);
            this.recordFrame(at, frame.length, image.width * image.height);
        }
        // A frame is the honest acknowledgement that this pane kept up, so the
        // next notch of the gesture goes out now and no faster.
        this.drainNotch(paneId);
    }

    private placementsFor(paneId: string): Map<string, LivePlacement> {
        const existing = this.livePlacements.get(paneId);
        if (existing !== undefined) return existing;
        const created = new Map<string, LivePlacement>();
        this.livePlacements.set(paneId, created);
        return created;
    }

    /** Keep our view of what a pane shows in step with a program's delete. */
    private forgetPlacements(block: InlineKittyBlock): void {
        const scope = block.keys.d ?? 'a';
        const target = Number(block.keys.i ?? block.keys.I);
        const all = scope === 'a' || scope === 'A';
        for (const [paneId, live] of this.livePlacements) {
            for (const [key, placement] of live) {
                if (all || placement.image.imageId === target) {
                    live.delete(key);
                    this.inlinePlaced.delete(`${paneId}:${key}`);
                }
            }
            if (live.size === 0) this.latestByPane.delete(paneId);
        }
    }

    /**
     * A queued placement of the same surface is this one, repainted. Two images
     * in one pane -- a plot beside its legend -- never supersede each other.
     */
    private superseded(key: string): boolean {
        const newer = this.inlineQueue.some((queued) => (queued.block.keys.a ?? 'p') !== 'd'
            && placementKey(queued.block) === key);
        if (newer) this.supersededFrames += 1;
        return newer;
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
        });
        this.latencies.length = 0;
        this.frameBytes.length = 0;
        this.framePixels.length = 0;
        this.supersededFrames = 0;
        this.notchesSent = 0;
        this.notchesDropped = 0;
    }

    private enqueue(file: GraphicsFile): void {
        this.write(clientGraphicsStarted(file));
        const origin = file.leading.toString('base64');
        const replaced = this.pendingByOrigin.get(origin);
        if (replaced !== undefined) {
            // A valid Herdr 0.8.2 server permits one direct transfer at a time.
            // If a future/pipelined sender violates that gate, consume the stale
            // full frame exactly once and retain only the latest for this origin.
            this.admitted.delete(replaced.transferId);
            this.write(clientGraphicsResult(replaced, true));
        } else {
            this.pendingOrigins.push(origin);
        }
        this.pendingByOrigin.set(origin, file);
        this.admit(file);
        if (!this.draining) void this.drain();
    }

    private async drain(): Promise<void> {
        this.draining = true;
        try {
            while (!this.closed) {
                const origin = this.pendingOrigins.shift();
                if (origin === undefined) return;
                const file = this.pendingByOrigin.get(origin);
                if (file === undefined) continue;
                this.pendingByOrigin.delete(origin);
                await this.forward(file);
            }
        } finally {
            this.draining = false;
            if (!this.closed && this.pendingOrigins.length > 0) void this.drain();
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
            const prepared = !processReady || paneId === undefined ? undefined : await prepareKitty(
                rgba, file.control, this.allocateImageId(), file.transferId,
            );
            if (this.shouldDrop(admitted, paneId)) return;
            if (paneId !== undefined && prepared !== undefined) {
                const previous = this.latestByPane.get(paneId);
                if (previous !== undefined) this.imageOwners.delete(previous.transferId);
                this.latestByPane.set(paneId, prepared);
                this.imageOwners.set(file.transferId, { paneId, imageId: prepared.imageId, sourceImageId: file.imageId });
                for (const registration of this.registrations.values()) {
                    if (registration.paneId === paneId) {
                        const frame = terminalFrame(
                            encodeKitty(prepared, registration, 'all'),
                            registration,
                            true,
                            undefined,
                            'full',
                        );
                        registration.write(frame);
                        this.recordFrame(startedAt, frame.length, prepared.width * prepared.height);
                    }
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

    private admit(file: GraphicsFile): AdmittedTransfer {
        const existing = this.admitted.get(file.transferId);
        if (existing !== undefined) return existing;
        const record: AdmittedTransfer = {
            sourceImageId: file.imageId,
            generation: this.nextGeneration,
            retired: false,
            cleared: false,
        };
        this.admitted.set(file.transferId, record);
        return record;
    }

    private shouldDrop(admitted: AdmittedTransfer, paneId?: string): boolean {
        if (paneId !== undefined) admitted.paneId = paneId;
        if (this.closed) return true;
        const retiredAt = admitted.paneId === undefined ? 0 : (this.paneRetiredGeneration.get(admitted.paneId) ?? 0);
        if (retiredAt > admitted.generation) return true;
        if (!admitted.retired) return false;
        if (!admitted.cleared && admitted.paneId !== undefined) {
            this.emitPaneClear(admitted.paneId, 'retired');
            admitted.cleared = true;
        }
        return true;
    }

    private emitPaneClear(paneId: string, reason?: TerminalGraphicsReason): void {
        this.latestByPane.delete(paneId);
        for (const [transferId, owner] of this.imageOwners) {
            if (owner.paneId === paneId) this.imageOwners.delete(transferId);
        }
        const bytes = Buffer.from('\u001b7\u001b_Ga=d,d=A,q=2;\u001b\\\u001b8');
        for (const registration of this.registrations.values()) {
            if (registration.paneId === paneId) registration.write(terminalFrame(bytes, registration, false, reason));
        }
    }

    private allocateImageId(): number {
        const used = new Set([...this.imageOwners.values()].map((owner) => owner.imageId));
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
        this.imageOwners.delete(transferId);
        const latest = this.latestByPane.get(owner.paneId);
        if (latest?.transferId === transferId) this.latestByPane.delete(owner.paneId);
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
            if (work.paneId === paneId) {
                work.retired = true;
                work.cleared = true;
            }
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

    private visibleRect(paneId: string): Promise<Rect | undefined> {
        const cached = this.layoutCache.get(paneId);
        if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
        const value = this.loadVisibleRect(paneId);
        this.layoutCache.set(paneId, { expiresAt: Date.now() + LAYOUT_CACHE_MS, value });
        return value;
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

    private async loadVisibleRect(paneId: string): Promise<Rect | undefined> {
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
            if (value === undefined || active === undefined
                || active.workspaceId !== value.workspace_id || active.tabId !== value.tab_id) return undefined;
            if (value.zoomed === true) return value.focused_pane_id === paneId ? value.area : undefined;
            return value.panes?.find((pane) => pane.pane_id === paneId)?.rect;
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

/** The absolute cell an inline block landed on, in the shape `sourcePane` parses. */
function cursorAt(block: InlineKittyBlock): Buffer {
    return Buffer.from(`\u001b[${block.row};${block.col}H`);
}

/** Place a forwarded block at the same cell inside the phone's pane view. */
function wrapInPane(bytes: Buffer, block: InlineKittyBlock, rect: Rect): Buffer {
    const row = Math.max(1, block.row - rect.y);
    const col = Math.max(1, block.col - rect.x);
    return Buffer.concat([
        Buffer.from('\u001b7'),
        Buffer.from(`\u001b[${row};${col}H`),
        bytes,
        Buffer.from('\u001b8'),
    ]);
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
    return {
        x: Math.max(1, Math.min(image.width, Math.round((x - left) / width * image.width))),
        y: Math.max(1, Math.min(image.height, Math.round((y - top) / height * image.height))),
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

function terminalFrame(
    bytes: Buffer,
    target: HerdrGraphicsRegistration,
    graphics?: boolean,
    graphicsReason?: TerminalGraphicsReason,
    graphicsSurface?: GraphicsSurface,
): string {
    return JSON.stringify({ type: 'terminal.frame', seq: 0, encoding: 'ansi', width: target.cols, height: target.rows,
        full: false, bytes: bytes.toString('base64'), ...(graphics === undefined ? {} : { graphics }),
        ...(graphicsReason === undefined ? {} : { graphicsReason }),
        ...(graphicsSurface === undefined ? {} : { graphicsSurface }) });
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

async function prepareKitty(rgba: Buffer, control: string, imageId: number, transferId: bigint): Promise<PreparedImage> {
    const width = Number(/(?:^|,)s=(\d+)/.exec(control)?.[1]);
    const height = Number(/(?:^|,)v=(\d+)/.exec(control)?.[1]);
    const sourceImageId = Number(/(?:^|,)i=(\d+)/.exec(control)?.[1]);
    if (![width, height, sourceImageId].every(Number.isFinite) || width <= 0 || height <= 0
        || width * height * 4 !== rgba.length) {
        throw new Error('invalid Herdr graphics control');
    }
    // Every byte of this frame is decrypted in JavaScript on the phone, so a
    // large image is worth real compression; a small one is not worth the wait.
    const level = rgba.length > COMPRESS_HARDER_BYTES ? 6 : 1;
    return { compressed: await compress(rgba, { level }), width, height, imageId, transferId };
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
    block?: InlineKittyBlock,
    rect?: Rect,
    surface: GraphicsSurface = 'full',
): Buffer {
    const encoded = image.compressed.toString('base64');
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK_CHARS) chunks.push(encoded.slice(offset, offset + KITTY_CHUNK_CHARS));
    // A pane-filling image is refitted to the phone's own grid; an image that
    // sits inside a program's text keeps the size and cell Herdr gave it, or it
    // would be blown up to fill a screen it never asked for.
    const placement = surface === 'inline' && block !== undefined
        ? inlinePlacement(block, rect)
        : graphicsPlacement(image, target);
    const { row, col, cols, rows } = placement;
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

/** Herdr's own cell and cell span, mapped into the phone's view of the pane. */
function inlinePlacement(block: InlineKittyBlock, rect?: Rect): GraphicsPlacement {
    const cols = Math.max(1, Number(block.keys.c ?? '1'));
    const rows = Math.max(1, Number(block.keys.r ?? '1'));
    return {
        cols: Number.isFinite(cols) ? cols : 1,
        rows: Number.isFinite(rows) ? rows : 1,
        row: Math.max(0, block.row - 1 - (rect?.y ?? 0)),
        col: Math.max(0, block.col - 1 - (rect?.x ?? 0)),
    };
}

/**
 * How much of the pane this placement covers. A program's small image must not
 * be treated as the pane's whole surface: the phone only takes over pointer and
 * scrolling for a surface that really is the pane.
 */
function surfaceOf(block: InlineKittyBlock, rect?: Rect): GraphicsSurface {
    if (rect === undefined) return 'full';
    const cols = Number(block.keys.c ?? '0');
    const rows = Number(block.keys.r ?? '0');
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return 'full';
    return cols >= rect.width * 0.9 && rows >= rect.height * 0.9 ? 'full' : 'inline';
}

/**
 * The surface a frame belongs to: the cell it lands on and the cells it covers.
 *
 * Not the image id. A repainting producer mints a new image for every frame, so
 * keying by id would mean nothing ever supersedes anything; keying by surface
 * makes a repaint replace its predecessor, while a second image elsewhere in
 * the pane -- a legend beside a plot -- keeps its own slot.
 */
function placementKey(block: InlineKittyBlock): string | undefined {
    const image = block.keys.i ?? block.keys.I;
    if (image === undefined || image === '') return undefined;
    return `${block.row}:${block.col}:${block.keys.c ?? ''}:${block.keys.r ?? ''}`;
}

/** The image a new frame supersedes, so exactly that one is deleted. */
function replaced(previous: LivePlacement | undefined, image: PreparedImage): 'none' | { imageId: number } {
    if (previous === undefined || previous.image.imageId === image.imageId) return 'none';
    return { imageId: previous.image.imageId };
}
