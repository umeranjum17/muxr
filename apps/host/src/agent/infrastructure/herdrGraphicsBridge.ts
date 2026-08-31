import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { deflate } from 'node:zlib';
import { promisify } from 'node:util';

const PROTOCOL_VERSION = 20;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const KITTY_CHUNK_CHARS = 4096;
const LAYOUT_CACHE_MS = 250;
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
type AppGeometry = { cols: number; rows: number; cellWidthPx: number; cellHeightPx: number };

export type GraphicsRoute = { paneId: string; rect?: { x: number; y: number; width: number; height: number } };
export type GraphicsPlacement = { col: number; row: number; cols: number; rows: number };
type Rect = NonNullable<GraphicsRoute['rect']>;
type ServerMessage =
    | { type: 'welcome'; version: number; error?: string }
    | { type: 'graphics'; bytes: Buffer }
    | { type: 'graphics-file'; file: GraphicsFile }
    | { type: 'retired'; transferId: bigint; imageId: number }
    | { type: 'closed' }
    | { type: 'other' };

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
    private workspaceCache: { expiresAt: number; value: Promise<{ workspaceId: string; tabId: string } | undefined> } | undefined;
    private lastErrorAt = 0;
    private processTimer: ReturnType<typeof setInterval> | undefined;
    private pollingProcesses = false;
    private input = Buffer.alloc(0);
    private draining = false;
    private nextImageId = 1;
    private closed = false;

    private constructor(
        private readonly socket: Socket,
        private readonly herdrBin: string,
    ) {
        socket.on('data', (data: Buffer) => { this.read(data); });
        socket.on('error', (error) => { process.stderr.write(`terminal graphics: ${error.message}\n`); this.close(); });
        socket.on('close', () => { this.close(); });
    }

    static async open(options: {
        cellWidthPx: number;
        cellHeightPx: number;
        herdrBin?: string;
        socketPath?: string;
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
        const bridge = new HerdrGraphicsBridge(socket, herdrBin);
        bridge.write(clientHello(geometry));
        return bridge;
    }

    register(registration: HerdrGraphicsRegistration): boolean {
        if (this.closed || !validRegistration(registration)) return false;
        this.registrations.set(registration.channel, registration);
        this.layoutCache.delete(registration.paneId);
        this.workspaceCache = undefined;
        if (!this.paneProcessGroups.has(registration.paneId)) this.processProbeAttempted.delete(registration.paneId);
        const latest = this.latestByPane.get(registration.paneId);
        if (latest !== undefined) registration.write(terminalFrame(encodeKitty(latest, registration, true), registration, true));
        return true;
    }

    unregister(channel: string): void {
        const removed = this.registrations.get(channel);
        this.registrations.delete(channel);
        if (removed !== undefined) this.layoutCache.delete(removed.paneId);
        this.workspaceCache = undefined;
    }

    hasRegistrations(): boolean { return this.registrations.size > 0; }

    scrollInput(channel: string, direction: 'up' | 'down', lines: number): Buffer[] {
        const registration = this.registrations.get(channel);
        const image = registration === undefined ? undefined : this.latestByPane.get(registration.paneId);
        const count = Math.min(40, Math.max(0, Math.trunc(lines)));
        if (image === undefined || count === 0) return [];
        const button = direction === 'up' ? 64 : 65;
        const report = Buffer.from(`\u001b[<${button};${Math.ceil(image.width / 2)};${Math.ceil(image.height / 2)}M`);
        return Array.from({ length: count }, () => report);
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
        if (this.closed) return;
        try { if (this.socket.writable) this.socket.write(frame(clientDetach())); } catch { /* socket already closed */ }
        this.closed = true;
        const clear = Buffer.from('\u001b7\u001b_Ga=d,d=A,q=2;\u001b\\\u001b8');
        for (const registration of this.registrations.values()) {
            registration.write(terminalFrame(clear, registration, false));
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
        this.workspaceCache = undefined;
        if (this.processTimer !== undefined) clearInterval(this.processTimer);
        this.processTimer = undefined;
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
            } else if (message.type === 'graphics') {
                // Protocol 20 provides no pane provenance. Drop rather than
                // crossing streams; PTY-inline Kitty is outside this bridge.
            } else if (message.type === 'graphics-file') {
                this.enqueue(message.file);
            } else if (message.type === 'retired') {
                this.retire(message.transferId, message.imageId);
            } else if (message.type === 'closed') {
                this.close();
            }
        }
    }

    private enqueue(file: GraphicsFile): void {
        this.write(clientGraphicsStarted(file));
        const origin = file.leading.toString('base64');
        const replaced = this.pendingByOrigin.get(origin);
        if (replaced !== undefined) {
            // A valid Herdr 0.8.2 server permits one direct transfer at a time.
            // If a future/pipelined sender violates that gate, consume the stale
            // full frame exactly once and retain only the latest for this origin.
            this.write(clientGraphicsResult(replaced, true));
        } else {
            this.pendingOrigins.push(origin);
        }
        this.pendingByOrigin.set(origin, file);
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
        let success = false;
        try {
            const rgba = await readGraphicsFile(file);
            const paneId = await this.sourcePane(file.leading);
            const processReady = paneId !== undefined && await this.ensurePaneProcess(paneId);
            const prepared = !processReady || paneId === undefined ? undefined : await prepareKitty(
                rgba, file.control, this.allocateImageId(), file.transferId,
            );
            // The local source is consumed before acknowledgement. The phone
            // leg independently bounds and coalesces WebSocket writes, so a
            // slow device never holds Herdr's single producer gate.
            if (paneId !== undefined && prepared !== undefined) {
                const previous = this.latestByPane.get(paneId);
                if (previous !== undefined) this.imageOwners.delete(previous.transferId);
                this.latestByPane.set(paneId, prepared);
                this.imageOwners.set(file.transferId, { paneId, imageId: prepared.imageId, sourceImageId: file.imageId });
                for (const registration of this.registrations.values()) {
                    if (registration.paneId === paneId) {
                        registration.write(terminalFrame(encodeKitty(prepared, registration, true), registration, true));
                    }
                }
            }
            // Herdr 0.8.2 treats `false` as failure of the whole direct client:
            // it disables direct graphics and retires every gate. A valid file
            // that is intentionally dropped for hidden/ambiguous routing was
            // still consumed successfully, so acknowledge it without delivery.
            success = true;
        } catch (error) {
            this.logError(error);
        }
        this.write(clientGraphicsResult(file, success));
    }

    private allocateImageId(): number {
        const used = new Set([...this.imageOwners.values()].map((owner) => owner.imageId));
        while (used.has(this.nextImageId)) this.nextImageId = this.nextImageId % 0x7fffffff + 1;
        const result = this.nextImageId;
        this.nextImageId = this.nextImageId % 0x7fffffff + 1;
        return result;
    }

    private retire(transferId: bigint, sourceImageId: number): void {
        const owner = this.imageOwners.get(transferId);
        if (owner === undefined || owner.sourceImageId !== sourceImageId) return;
        this.imageOwners.delete(transferId);
        const latest = this.latestByPane.get(owner.paneId);
        const clearsPane = latest?.transferId === transferId;
        if (clearsPane) {
            this.latestByPane.delete(owner.paneId);
            this.paneProcessGroups.delete(owner.paneId);
            this.processProbeAttempted.delete(owner.paneId);
            this.processProbeFailures.delete(owner.paneId);
        }
        const bytes = Buffer.from(`\u001b7\u001b_Ga=d,d=i,i=${owner.imageId},q=2;\u001b\\\u001b8`);
        for (const registration of this.registrations.values()) {
            if (registration.paneId === owner.paneId) {
                registration.write(terminalFrame(bytes, registration, clearsPane ? false : undefined));
            }
        }
    }

    private async ensurePaneProcess(paneId: string): Promise<boolean> {
        if (this.paneProcessGroups.has(paneId)) return true;
        if (this.processProbeAttempted.has(paneId)) return false;
        this.processProbeAttempted.add(paneId);
        const processGroup = await this.foregroundProcessGroup(paneId);
        if (processGroup === undefined) {
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
        this.latestByPane.delete(paneId);
        this.paneProcessGroups.delete(paneId);
        this.processProbeAttempted.delete(paneId);
        this.processProbeFailures.delete(paneId);
        for (const [transferId, owner] of this.imageOwners) {
            if (owner.paneId === paneId) this.imageOwners.delete(transferId);
        }
        const bytes = Buffer.from('\u001b7\u001b_Ga=d,d=A,q=2;\u001b\\\u001b8');
        for (const registration of this.registrations.values()) {
            if (registration.paneId === paneId) registration.write(terminalFrame(bytes, registration, false));
        }
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

export function mapGraphicsPointer(
    image: PreparedImage,
    target: HerdrGraphicsRegistration,
    pointer: HerdrGraphicsPointer,
): { x: number; y: number } | undefined {
    if (!validPointer(pointer)) return undefined;
    const placement = graphicsPlacement(image, target);
    const left = placement.col * target.cellWidthPx;
    const top = placement.row * target.cellHeightPx;
    const width = placement.cols * target.cellWidthPx;
    const height = placement.rows * target.cellHeightPx;
    if (pointer.x < left || pointer.x > left + width || pointer.y < top || pointer.y > top + height) return undefined;
    return {
        x: Math.max(1, Math.min(image.width, Math.round((pointer.x - left) / width * image.width))),
        y: Math.max(1, Math.min(image.height, Math.round((pointer.y - top) / height * image.height))),
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
        case 2: reader.uint(); reader.number(); reader.number(); reader.boolean(); reader.bytes(); return { type: 'other' };
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

function terminalFrame(bytes: Buffer, target: HerdrGraphicsRegistration, graphics?: boolean): string {
    return JSON.stringify({ type: 'terminal.frame', seq: 0, encoding: 'ansi', width: target.cols, height: target.rows,
        full: false, bytes: bytes.toString('base64'), ...(graphics === undefined ? {} : { graphics }) });
}

async function readGraphicsFile(file: GraphicsFile): Promise<Buffer> {
    const length = Number(file.expectedLength);
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_IMAGE_BYTES) throw new Error('invalid graphics length');
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
    return { compressed: await compress(rgba, { level: 1 }), width, height, imageId, transferId };
}

export function encodeKitty(image: PreparedImage, target: HerdrGraphicsRegistration, clear: boolean): Buffer {
    const encoded = image.compressed.toString('base64');
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK_CHARS) chunks.push(encoded.slice(offset, offset + KITTY_CHUNK_CHARS));
    const { row, col, cols, rows } = graphicsPlacement(image, target);
    const placementId = image.imageId & 0x7fffffff;
    const output: Buffer[] = [Buffer.from('\u001b7')];
    if (clear) output.push(Buffer.from('\u001b_Ga=d,d=A,q=2;\u001b\\'));
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
