/**
 * Bounded pre-parser for the standard Kitty subset emitted by the host
 * GraphicsFile bridge. xterm 6 has no APC hook, so frames are split here
 * before term.write. This is not arbitrary PTY Kitty support.
 */

export const MAX_KITTY_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_KITTY_HEADER_CHARS = 512;
export const MAX_KITTY_CHUNK_CHARS = 4096;
export const MAX_KITTY_PLACEMENTS = 1;

const ESC = 0x1b;
const APC = 0x5f; // _
const ST = 0x5c; // \

export type KittyPlacement = {
    id: number;
    width: number;
    height: number;
    rgba: Uint8Array;
    col: number;
    row: number;
    cols: number;
    rows: number;
};

export type KittyDecodeError = 'malformed' | 'oversized' | 'unsupported';

export type KittyCommand =
    | { kind: 'transmit'; id: number; width: number; height: number; payload: Uint8Array; more: boolean; col?: number; row?: number; cols?: number; rows?: number }
    | { kind: 'delete-all' }
    | { kind: 'delete-image'; id: number };

export interface KittyDecoderState {
    pending: Uint8Array;
    chunks: Uint8Array[];
    transmit?: { id: number; width: number; height: number; col: number; row: number; cols: number; rows: number };
    lastCup?: { col: number; row: number };
}

export function createKittyDecoderState(): KittyDecoderState {
    return { pending: new Uint8Array(0), chunks: [] };
}

export function splitKittyFrame(bytes: Uint8Array, state: KittyDecoderState): {
    ansi: Uint8Array;
    commands: KittyCommand[];
    error?: KittyDecodeError;
} {
    const input = state.pending.length === 0 ? bytes : concat(state.pending, bytes);
    state.pending = new Uint8Array(0);
    const ansi: number[] = [];
    const commands: KittyCommand[] = [];
    let index = 0;
    while (index < input.length) {
        if (input[index] === ESC) {
            const left = input.length - index;
            if (left < 3) {
                const second = left >= 2 ? input[index + 1] : undefined;
                if (second === undefined || second === 0x5b || second === APC) {
                    state.pending = input.subarray(index);
                    break;
                }
            }
        }
        if (input[index] === ESC && input[index + 1] === 0x5b) {
            const cup = readCup(input, index);
            if (cup !== undefined) {
                state.lastCup = { col: cup.col, row: cup.row };
                for (let cursor = index; cursor < cup.next; cursor += 1) ansi.push(input[cursor]!);
                index = cup.next;
                continue;
            }
        }
        if (input[index] !== ESC || input[index + 1] !== APC || input[index + 2] !== 0x47) {
            ansi.push(input[index]!);
            index += 1;
            continue;
        }
        const end = findSt(input, index + 3);
        if (end < 0) {
            if (input.length - index > MAX_KITTY_IMAGE_BYTES) {
                state.pending = new Uint8Array(0);
                state.transmit = undefined;
                state.chunks = [];
                return { ansi: Uint8Array.from(ansi), commands, error: 'oversized' };
            }
            state.pending = input.subarray(index);
            break;
        }
        const body = input.subarray(index + 3, end);
        index = end + 2;
        const parsed = parseCommand(body, state);
        if (parsed.error !== undefined) {
            for (; index < input.length; index += 1) ansi.push(input[index]!);
            return { ansi: Uint8Array.from(ansi), commands, error: parsed.error };
        }
        if (parsed.command !== undefined) commands.push(parsed.command);
    }
    return { ansi: Uint8Array.from(ansi), commands };
}

export async function materializeKittyCommands(
    commands: KittyCommand[],
    inflate: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<{ placements: KittyPlacement[]; deleteAll: boolean; deleteIds: number[]; error?: KittyDecodeError }> {
    const placements: KittyPlacement[] = [];
    const deleteIds: number[] = [];
    let deleteAll = false;
    for (const command of commands) {
        if (command.kind === 'delete-all') {
            deleteAll = true;
            placements.length = 0;
            continue;
        }
        if (command.kind === 'delete-image') {
            deleteIds.push(command.id);
            const index = placements.findIndex((item) => item.id === command.id);
            if (index >= 0) placements.splice(index, 1);
            continue;
        }
        if (placements.length >= MAX_KITTY_PLACEMENTS) return { placements, deleteAll, deleteIds, error: 'oversized' };
        let rgba: Uint8Array;
        try {
            rgba = await inflate(command.payload);
        } catch {
            return { placements, deleteAll, deleteIds, error: 'malformed' };
        }
        if (rgba.byteLength !== command.width * command.height * 4 || rgba.byteLength > MAX_KITTY_IMAGE_BYTES) {
            return { placements, deleteAll, deleteIds, error: 'malformed' };
        }
        placements.push({
            id: command.id,
            width: command.width,
            height: command.height,
            rgba,
            col: command.col ?? 0,
            row: command.row ?? 0,
            cols: command.cols ?? 1,
            rows: command.rows ?? 1,
        });
    }
    return { placements, deleteAll, deleteIds };
}

function arrayBufferPart(data: Uint8Array): ArrayBuffer {
    if (data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.buffer.byteLength === data.byteLength) {
        return data.buffer;
    }
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
}

export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream !== 'function') throw new Error('deflate unavailable');
    const stream = new Blob([arrayBufferPart(data)]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseCommand(body: Uint8Array, state: KittyDecoderState): { command?: KittyCommand; error?: KittyDecodeError } {
    const text = decoder.decode(body);
    const separator = text.indexOf(';');
    if (separator < 0) return { error: 'malformed' };
    const header = text.slice(0, separator);
    const payload = text.slice(separator + 1);
    if (header.length > MAX_KITTY_HEADER_CHARS || payload.length > MAX_KITTY_CHUNK_CHARS) return { error: 'oversized' };
    const fields = parseHeader(header);
    const action = fields.a ?? 'T';
    if (action === 'd') {
        if (fields.d === 'A') return { command: { kind: 'delete-all' } };
        if (fields.d === 'i' && fields.i !== undefined) return { command: { kind: 'delete-image', id: fields.i } };
        return failUnsupported(state);
    }
    if (action !== 'T') return failUnsupported(state);
    if (fields.f !== undefined && fields.f !== 32) return failUnsupported(state);
    if (fields.t !== undefined && fields.t !== 'd') return failUnsupported(state);
    if (fields.o !== undefined && fields.o !== 'z') return failUnsupported(state);
    let bytes: Uint8Array;
    try {
        bytes = decodeBase64(payload);
    } catch {
        return { error: 'malformed' };
    }
    const more = fields.m === 1;
    if (state.transmit === undefined) {
        if (fields.s === undefined || fields.v === undefined || fields.i === undefined || fields.s <= 0 || fields.v <= 0) {
            return { error: 'malformed' };
        }
        if (fields.s * fields.v * 4 > MAX_KITTY_IMAGE_BYTES || bytes.length > MAX_KITTY_IMAGE_BYTES) return { error: 'oversized' };
        state.transmit = {
            id: fields.i,
            width: fields.s,
            height: fields.v,
            col: (state.lastCup?.col ?? 1) - 1,
            row: (state.lastCup?.row ?? 1) - 1,
            cols: fields.c ?? 1,
            rows: fields.r ?? 1,
        };
        state.chunks = [bytes];
    } else {
        let total = bytes.length;
        for (const chunk of state.chunks) total += chunk.length;
        if (total > MAX_KITTY_IMAGE_BYTES) {
            state.transmit = undefined;
            state.chunks = [];
            return { error: 'oversized' };
        }
        state.chunks.push(bytes);
    }
    if (more) return {};
    const transmit = state.transmit;
    const payloadBytes = concat(...state.chunks);
    state.transmit = undefined;
    state.chunks = [];
    if (transmit === undefined) return { error: 'malformed' };
    return {
        command: {
            kind: 'transmit',
            id: transmit.id,
            width: transmit.width,
            height: transmit.height,
            payload: payloadBytes,
            more: false,
            col: transmit.col,
            row: transmit.row,
            cols: transmit.cols,
            rows: transmit.rows,
        },
    };
}

function failUnsupported(state: KittyDecoderState): { error: KittyDecodeError } {
    state.transmit = undefined;
    state.chunks = [];
    return { error: 'unsupported' };
}

type KittyFields = {
    a?: string;
    d?: string;
    t?: string;
    o?: string;
    f?: number;
    i?: number;
    m?: number;
    s?: number;
    v?: number;
    c?: number;
    r?: number;
};

function parseSignedInt(value: string): number | undefined {
    if (!/^-?\d+$/.test(value)) return undefined;
    return Number(value);
}

function parseHeader(header: string): KittyFields {
    const fields: KittyFields = {};
    if (header === '') return fields;
    for (const part of header.split(',')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = part.slice(0, eq);
        const value = part.slice(eq + 1);
        if (!/^[a-zA-Z]$/.test(key)) continue;
        if (key === 'a' || key === 'd' || key === 't' || key === 'o') {
            fields[key] = value;
            continue;
        }
        const parsed = parseSignedInt(value);
        if (key === 'f') {
            // Non-numeric format stays a present non-32 value so the caller
            // still returns unsupported (xterm passthrough), not omitted.
            fields.f = parsed ?? Number.NaN;
            continue;
        }
        if (parsed === undefined) continue;
        if (key === 'i' || key === 'm' || key === 's' || key === 'v' || key === 'c' || key === 'r') {
            fields[key] = parsed;
        }
    }
    return fields;
}

function readCup(input: Uint8Array, start: number): { row: number; col: number; next: number } | undefined {
    let cursor = start + 2;
    let row = 0;
    let col = 0;
    let field = 0;
    while (cursor < input.length) {
        const byte = input[cursor]!;
        if (byte >= 0x30 && byte <= 0x39) {
            const next = (field === 0 ? row : col) * 10 + (byte - 0x30);
            if (next > 10_000) return undefined;
            if (field === 0) row = next; else col = next;
            cursor += 1;
            continue;
        }
        if (byte === 0x3b && field === 0) { field = 1; cursor += 1; continue; }
        if (byte === 0x48 && field === 1 && row > 0 && col > 0) return { row, col, next: cursor + 1 };
        return undefined;
    }
    return undefined;
}

function findSt(input: Uint8Array, start: number): number {
    for (let index = start; index < input.length - 1; index += 1) {
        if (input[index] === ESC && input[index + 1] === ST) return index;
    }
    return -1;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function decodeBase64(value: string): Uint8Array {
    if (value === '') return new Uint8Array(0);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('invalid base64');
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

const decoder = new TextDecoder();
