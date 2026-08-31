import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { deflate } from 'node:zlib';
import { promisify } from 'node:util';

const PROTOCOL_VERSION = 20;
const APP_COLS = 101;
const APP_ROWS = 40;
const APP_CELL_WIDTH_PX = 8;
const APP_CELL_HEIGHT_PX = 16;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const KITTY_CHUNK_CHARS = 4096;
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

type PreparedImage = {
    compressed: Buffer;
    width: number;
    height: number;
    imageId: number;
};

type Rect = { x: number; y: number; width: number; height: number };
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
    private readonly imagePane = new Map<number, string>();
    private input = Buffer.alloc(0);
    private closed = false;

    private constructor(
        private readonly socket: Socket,
        private readonly herdrBin: string,
    ) {
        socket.on('data', (data: Buffer) => { this.read(data); });
        socket.on('error', (error) => { process.stderr.write(`terminal graphics: ${error.message}\n`); this.close(); });
        socket.on('close', () => { this.closed = true; });
    }

    static async open(options: { herdrBin?: string; socketPath?: string } = {}): Promise<HerdrGraphicsBridge> {
        if (process.platform === 'win32') throw new Error('Herdr direct graphics requires a Unix client socket');
        const socketPath = options.socketPath ?? process.env.HERDR_CLIENT_SOCKET_PATH
            ?? join(homedir(), '.config', 'herdr', 'herdr-client.sock');
        const socket = createConnection(socketPath);
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        const bridge = new HerdrGraphicsBridge(socket, options.herdrBin ?? 'herdr');
        bridge.write(clientHello());
        return bridge;
    }

    register(registration: HerdrGraphicsRegistration): boolean {
        if (!validRegistration(registration)) return false;
        this.registrations.set(registration.channel, registration);
        const latest = this.latestByPane.get(registration.paneId);
        if (latest !== undefined) registration.write(terminalFrame(encodeKitty(latest, registration, true), registration, true));
        return true;
    }

    unregister(channel: string): void {
        const removed = this.registrations.get(channel);
        this.registrations.delete(channel);
        if (removed !== undefined && ![...this.registrations.values()].some((item) => item.paneId === removed.paneId)) {
            this.latestByPane.delete(removed.paneId);
            for (const [imageId, paneId] of this.imagePane) if (paneId === removed.paneId) this.imagePane.delete(imageId);
        }
    }

    hasRegistrations(): boolean { return this.registrations.size > 0; }

    pointerInput(channel: string, pointer: HerdrGraphicsPointer): Buffer[] {
        const registration = this.registrations.get(channel);
        const image = registration === undefined ? undefined : this.latestByPane.get(registration.paneId);
        if (registration === undefined || image === undefined || !validPointer(pointer)) return [];
        const x = Math.max(1, Math.min(image.width, Math.round(pointer.x / pointer.width * image.width)));
        const y = Math.max(1, Math.min(image.height, Math.round(pointer.y / pointer.height * image.height)));
        if (pointer.phase === 'down') return [Buffer.from(`\u001b[<35;${x};${y}M`), Buffer.from(`\u001b[<0;${x};${y}M`)];
        return [Buffer.from(`\u001b[<${pointer.phase === 'move' ? 32 : 0};${x};${y}${pointer.phase === 'up' ? 'm' : 'M'}`)];
    }

    async pointer(channel: string, pointer: HerdrGraphicsPointer): Promise<void> {
        const registration = this.registrations.get(channel);
        if (registration === undefined || !validPointer(pointer)) return;
        const rect = await this.visibleRect(registration.paneId);
        if (rect === undefined) return;
        const image = this.latestByPane.get(registration.paneId);
        if (image === undefined) return;
        const localX = Math.max(0, Math.min(1, pointer.x / pointer.width));
        const localY = Math.max(0, Math.min(1, pointer.y / pointer.height));
        const paneLeft = rect.x * APP_CELL_WIDTH_PX;
        const paneTop = rect.y * APP_CELL_HEIGHT_PX;
        const x = Math.max(paneLeft + 1, Math.min((rect.x + rect.width) * APP_CELL_WIDTH_PX,
            Math.round(paneLeft + localX * image.width)));
        const y = Math.max(paneTop + 1, Math.min((rect.y + rect.height) * APP_CELL_HEIGHT_PX,
            Math.round(paneTop + localY * image.height)));
        const suffix = pointer.phase === 'up' ? 'm' : 'M';
        const button = pointer.phase === 'move' ? 32 : 0;
        if (pointer.phase === 'down') this.write(clientInputPixels(Buffer.from(`\u001b[<35;${x};${y}M`)));
        const report = Buffer.from(`\u001b[<${button};${x};${y}${suffix}`);
        this.write(clientInputPixels(report));
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try { this.write(clientDetach()); } catch { /* socket already closed */ }
        this.registrations.clear();
        this.latestByPane.clear();
        this.imagePane.clear();
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
                // Inline bytes lack a source pane in protocol 20; routing them
                // without provenance would cross streams, so fail open to text.
                process.stderr.write(`terminal graphics: dropped unscoped inline graphics (${message.bytes.length} bytes)\n`);
            } else if (message.type === 'graphics-file') {
                void this.forward(message.file);
            } else if (message.type === 'retired') {
                this.retire(message.imageId);
            } else if (message.type === 'closed') {
                this.close();
            }
        }
    }

    private async forward(file: GraphicsFile): Promise<void> {
        this.write(clientGraphicsStarted(file));
        let success = false;
        try {
            const length = Number(file.expectedLength);
            if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_IMAGE_BYTES) throw new Error('invalid graphics length');
            const rgba = await readFile(file.path);
            if (rgba.length !== length) throw new Error('graphics file changed');
            const paneId = await this.sourcePane(file.leading);
            const prepared = paneId === undefined ? undefined : await prepareKitty(rgba, file.control);
            // The source is consumed before acknowledgement. Phone writes are
            // synchronous queue operations and never hold Herdr's one producer.
            if (paneId !== undefined && prepared !== undefined) {
                this.latestByPane.set(paneId, prepared);
                this.imagePane.set(prepared.imageId, paneId);
                for (const registration of this.registrations.values()) {
                    if (registration.paneId === paneId) {
                        registration.write(terminalFrame(encodeKitty(prepared, registration, false), registration, true));
                    }
                }
            }
            success = true;
        } catch (error) {
            process.stderr.write(`terminal graphics: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        this.write(clientGraphicsResult(file, success));
    }

    private retire(imageId: number): void {
        const paneId = this.imagePane.get(imageId);
        if (paneId === undefined) return;
        this.imagePane.delete(imageId);
        this.latestByPane.delete(paneId);
        const bytes = Buffer.from(`\u001b7\u001b_Ga=d,d=i,i=${imageId},q=2;\u001b\\\u001b8`);
        for (const registration of this.registrations.values()) {
            if (registration.paneId === paneId) registration.write(terminalFrame(bytes, registration, true));
        }
    }

    private async sourcePane(leading: Buffer): Promise<string | undefined> {
        const match = /^\u001b\[(\d+);(\d+)H$/.exec(leading.toString('utf8'));
        if (match === null) return undefined;
        const row = Number(match[1]) - 1;
        const col = Number(match[2]) - 1;
        const matches: string[] = [];
        for (const paneId of new Set([...this.registrations.values()].map((item) => item.paneId))) {
            const rect = await this.visibleRect(paneId);
            if (rect !== undefined && col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height) {
                matches.push(paneId);
            }
        }
        return matches.length === 1 ? matches[0] : undefined;
    }

    private async visibleRect(paneId: string): Promise<Rect | undefined> {
        try {
            const [{ stdout: workspacesRaw }, { stdout: layoutRaw }] = await Promise.all([
                run(this.herdrBin, ['workspace', 'list'], { timeout: 3000 }),
                run(this.herdrBin, ['pane', 'layout', '--pane', paneId], { timeout: 3000 }),
            ]);
            const workspaces = JSON.parse(workspacesRaw) as { result?: { workspaces?: { workspace_id?: string; active_tab_id?: string; focused?: boolean }[] } };
            const layout = JSON.parse(layoutRaw) as { result?: { layout?: {
                workspace_id?: string;
                tab_id?: string;
                focused_pane_id?: string;
                zoomed?: boolean;
                area?: Rect;
                panes?: { pane_id?: string; rect?: Rect }[];
            } } };
            const value = layout.result?.layout;
            const active = workspaces.result?.workspaces?.find((item) => item.focused === true);
            if (value === undefined || active === undefined
                || active.workspace_id !== value.workspace_id || active.active_tab_id !== value.tab_id) return undefined;
            if (value.zoomed === true && value.focused_pane_id === paneId) return value.area;
            return value.panes?.find((pane) => pane.pane_id === paneId)?.rect;
        } catch {
            return undefined;
        }
    }
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

function vector(value: Buffer): Buffer { return Buffer.concat([uint(value.length), value]); }
function clientHello(): Buffer {
    return Buffer.concat([uint(0), uint(PROTOCOL_VERSION), uint(APP_COLS), uint(APP_ROWS), uint(APP_CELL_WIDTH_PX), uint(APP_CELL_HEIGHT_PX),
        uint(1), uint(0), uint(1)]); // TerminalAnsi, server keybindings, AppDirectGraphics
}
function clientDetach(): Buffer { return uint(4); }
function clientGraphicsResult(file: GraphicsFile, success: boolean): Buffer {
    return Buffer.concat([uint(10), uint(file.transferId), uint(file.imageId), Buffer.from([success ? 1 : 0])]);
}
function clientInputPixels(data: Buffer): Buffer {
    return Buffer.concat([uint(11), vector(data), uint(APP_COLS), uint(APP_ROWS),
        uint(APP_COLS * APP_CELL_WIDTH_PX), uint(APP_ROWS * APP_CELL_HEIGHT_PX)]);
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

function terminalFrame(bytes: Buffer, target: HerdrGraphicsRegistration, graphics = false): string {
    return JSON.stringify({ type: 'terminal.frame', seq: 0, encoding: 'ansi', width: target.cols, height: target.rows,
        full: false, bytes: bytes.toString('base64'), ...(graphics ? { graphics: true } : {}) });
}

async function prepareKitty(rgba: Buffer, control: string): Promise<PreparedImage> {
    const width = Number(/(?:^|,)s=(\d+)/.exec(control)?.[1]);
    const height = Number(/(?:^|,)v=(\d+)/.exec(control)?.[1]);
    const imageId = Number(/(?:^|,)i=(\d+)/.exec(control)?.[1]);
    if (![width, height, imageId].every(Number.isFinite) || width <= 0 || height <= 0 || width * height * 4 !== rgba.length) {
        throw new Error('invalid Herdr graphics control');
    }
    return { compressed: await compress(rgba, { level: 1 }), width, height, imageId };
}

export function encodeKitty(image: PreparedImage, target: HerdrGraphicsRegistration, clear: boolean): Buffer {
    const encoded = image.compressed.toString('base64');
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK_CHARS) chunks.push(encoded.slice(offset, offset + KITTY_CHUNK_CHARS));
    const cellAspect = target.cellWidthPx / target.cellHeightPx;
    let cols = target.cols;
    let rows = Math.max(1, Math.round(image.height / image.width * cols * cellAspect));
    if (rows > target.rows) { rows = target.rows; cols = Math.max(1, Math.round(image.width / image.height * rows / cellAspect)); }
    const row = Math.max(0, Math.floor((target.rows - rows) / 2));
    const col = Math.max(0, Math.floor((target.cols - cols) / 2));
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
