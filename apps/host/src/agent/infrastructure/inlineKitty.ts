/**
 * Kitty graphics carried inline in Herdr's app terminal stream.
 *
 * Herdr 0.8.2 does not hand this client a leased file for every image. Anything
 * a program writes to its own PTY -- `kitten icat`, a terminal browser, a plot
 * -- arrives as an APC block inside the full-app output frame, positioned by
 * the cursor Herdr set just before it. This scanner is the provenance the
 * file-frame path gets for free: it follows absolute cursor moves and hands
 * back each complete APC block with the cell it landed on.
 *
 * It is deliberately not a terminal emulator. It tracks the sequences Herdr's
 * renderer actually emits for placement -- CUP, HVP, CR/LF -- and treats
 * everything else as opaque.
 */

import { promisify } from 'node:util';
import { inflate as inflateRaw } from 'node:zlib';

const ESC = 0x1b;
const APC_INTRODUCER = 0x5f; // ESC _
const STRING_TERMINATOR = 0x5c; // ESC \
const KITTY_MARKER = 0x47; // 'G'

export type InlineKittyBlock = {
    /** Verbatim APC block, `ESC _ G ... ESC \`, ready to forward. */
    bytes: Buffer;
    /** Parsed control keys, e.g. `a`, `i`, `m`, `c`, `r`. */
    keys: Record<string, string>;
    /** One-based cell the block was written at. */
    row: number;
    col: number;
};

/** Cursor the scanner carries between frames; one instance per stream. */
export class InlineKittyScanner {
    private row = 1;
    private col = 1;
    /** An APC block can be split across socket frames. */
    private carry: Buffer = Buffer.alloc(0);

    scan(chunk: Buffer): InlineKittyBlock[] {
        const data: Buffer = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
        this.carry = Buffer.alloc(0);
        const blocks: InlineKittyBlock[] = [];
        let index = 0;
        while (index < data.length) {
            const escape = data.indexOf(ESC, index);
            if (escape < 0) break;
            if (escape + 1 >= data.length) { this.carry = Buffer.from(data.subarray(escape)); return blocks; }
            const introducer = data[escape + 1];
            if (introducer === APC_INTRODUCER) {
                const end = terminatorAt(data, escape + 2);
                if (end < 0) { this.carry = Buffer.from(data.subarray(escape)); return blocks; }
                const block = data.subarray(escape, end + 2);
                if (data[escape + 2] === KITTY_MARKER) {
                    blocks.push({ bytes: Buffer.from(block), keys: parseKeys(block), row: this.row, col: this.col });
                }
                index = end + 2;
                continue;
            }
            if (introducer === 0x5b) { // CSI
                const final = finalByteAt(data, escape + 2);
                if (final < 0) { this.carry = Buffer.from(data.subarray(escape)); return blocks; }
                this.applyCsi(data.subarray(escape + 2, final), data[final] ?? 0);
                index = final + 1;
                continue;
            }
            index = escape + 2;
        }
        return blocks;
    }

    private applyCsi(params: Buffer, final: number): void {
        // H (CUP) and f (HVP) are the only absolute moves Herdr's renderer uses
        // to place a cell run, and the only ones an image's position depends on.
        if (final !== 0x48 && final !== 0x66) return;
        const [row, col] = params.toString('latin1').split(';');
        this.row = positive(row);
        this.col = positive(col);
    }
}

function positive(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function terminatorAt(data: Buffer, from: number): number {
    for (let index = from; index + 1 < data.length; index += 1) {
        if (data[index] === ESC && data[index + 1] === STRING_TERMINATOR) return index;
    }
    return -1;
}

function finalByteAt(data: Buffer, from: number): number {
    for (let index = from; index < data.length; index += 1) {
        const byte = data[index] ?? 0;
        if (byte >= 0x40 && byte <= 0x7e) return index;
    }
    return -1;
}

/** `ESC _ G a=T,f=32,i=7;payload ESC \` -> `{ a: 'T', f: '32', i: '7' }`. */
export function parseKeys(block: Buffer): Record<string, string> {
    const text = block.toString('latin1');
    const start = text.indexOf('G') + 1;
    const end = text.indexOf(';', start);
    const header = end < 0 ? text.slice(start, text.length - 2) : text.slice(start, end);
    const keys: Record<string, string> = {};
    for (const pair of header.split(',')) {
        const equals = pair.indexOf('=');
        if (equals > 0) keys[pair.slice(0, equals)] = pair.slice(equals + 1);
    }
    return keys;
}

/**
 * Kitty transmits an image once and places it separately, so a pane only needs
 * the pixel payload the first time one of its placements references the image.
 * Chunked transmissions (`m=1`) accumulate here until the closing chunk.
 */
const inflate = promisify(inflateRaw);

export class InlineImageStore {
    private readonly complete = new Map<string, Buffer>();
    private readonly partial = new Map<string, Buffer[]>();
    private order: string[] = [];
    /** Continuation chunks carry no image id; they belong to this transfer. */
    private active: string | undefined;
    /** Prepared frames keyed by image id; decoding a repaint twice is waste. */
    private readonly preparedById = new Map<string, unknown>();
    /**
     * Transmissions are stamped with a global counter and tracked per id, so
     * a genuine retransmission of one id is distinguishable from a
     * placement-only replay of the cached pixels while unrelated images do
     * not move another id's lookup. The per-id map is pruned with eviction.
     */
    private nextTransmissionStamp = 0;
    private readonly latestStampById = new Map<string, number>();

    constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

    /** The id's latest transmission stamp: 0 before its first transfer. */
    stampOf(id: string): number {
        return this.latestStampById.get(id) ?? 0;
    }

    /** The counter as it stands now, for deletes that must not forget
     *  transmissions admitted after them in the same scanned chunk. */
    currentTransmissionStamp(): number {
        return this.nextTransmissionStamp;
    }

    /** Returns true when the block was consumed as image data. */
    admit(block: InlineKittyBlock): boolean {
        const action = block.keys.a;
        const continuation = action === undefined && this.active !== undefined;
        if (!continuation && action !== 't' && action !== 'q') return false;
        const id = imageKey(block.keys) ?? this.active;
        if (id === undefined) return true;
        const chunks = this.partial.get(id) ?? [];
        chunks.push(block.bytes);
        if (block.keys.m === '1') {
            this.partial.set(id, chunks);
            this.active = id;
            return true;
        }
        this.partial.delete(id);
        this.active = undefined;
        this.store(id, Buffer.concat(chunks));
        return true;
    }

    /**
     * Pixels for a placement, decoded once and kept prepared. Inline payloads
     * are base64 in the APC blocks, optionally zlib (`o=z`); the phone gets the
     * same compressed, pane-fitted frame the file path produces.
     */
    async prepared<T>(
        placement: InlineKittyBlock,
        prepare: (rgba: Buffer, control: string) => Promise<T>,
    ): Promise<T | undefined> {
        const id = imageKey(placement.keys);
        if (id === undefined) return undefined;
        const cached = this.preparedById.get(id) as T | undefined;
        if (cached !== undefined) return cached;
        const blocks = this.complete.get(id);
        if (blocks === undefined) return undefined;
        const keys = parseKeys(blocks);
        if ((keys.f ?? '32') !== '32') return undefined;
        const payload = Buffer.from(payloadOf(blocks), 'base64');
        const rgba = keys.o === 'z' ? await inflate(payload) : payload;
        const control = `s=${keys.s ?? ''},v=${keys.v ?? ''},i=${id}`;
        try {
            const value = await prepare(rgba, control);
            // The pixels may have been deleted or retransmitted while the
            // preparation was in flight; only resident, unmoved bytes may
            // re-enter the cache.
            if (this.complete.get(id) !== blocks) return value;
            this.preparedById.set(id, value);
            return value;
        } catch {
            return undefined;
        }
    }

    /**
     * Executes resident-image deletion for an uppercase delete (`d=I`, or
     * `d=A` for every image): the pixels leave the cache, so no later
     * placement-only replay can revive them. Lowercase scopes remove
     * placements only and keep resident pixels.
     */
    forgetImage(block: InlineKittyBlock, residentStamp: number): void {
        const scope = block.keys.d ?? 'a';
        const id = imageKey(block.keys);
        if (scope === 'A' || (scope === 'I' && id === undefined)) {
            // Only bytes resident at the delete survive its reach: a
            // transmission admitted later in the same scanned chunk is newer.
            for (const [stampedId, stamp] of [...this.latestStampById]) {
                if (stamp > residentStamp) continue;
                this.complete.delete(stampedId);
                this.preparedById.delete(stampedId);
                this.latestStampById.delete(stampedId);
                this.order = this.order.filter((item) => item !== stampedId);
            }
            return;
        }
        if (scope !== 'I' || id === undefined) return;
        // A retransmission admitted after the delete is newer than it: the
        // deleted bytes are already gone and the new ones must stay.
        if ((this.latestStampById.get(id) ?? 0) > residentStamp) return;
        this.complete.delete(id);
        this.preparedById.delete(id);
        this.latestStampById.delete(id);
        this.order = this.order.filter((item) => item !== id);
    }

    private store(id: string, bytes: Buffer): void {
        if (bytes.length > this.maxBytes) return;
        if (!this.complete.has(id)) this.order.push(id);
        this.complete.set(id, bytes);
        this.latestStampById.set(id, ++this.nextTransmissionStamp);
        // New bytes under a known id are a retransmission: the prepared frame
        // built from the old bytes is stale.
        this.preparedById.delete(id);
        let total = [...this.complete.values()].reduce((sum, item) => sum + item.length, 0);
        while (total > this.maxBytes && this.order.length > 1) {
            const oldest = this.order.shift()!;
            total -= this.complete.get(oldest)?.length ?? 0;
            this.complete.delete(oldest);
            this.preparedById.delete(oldest);
            this.latestStampById.delete(oldest);
        }
    }
}

/** Every chunk's base64 payload, concatenated. */
function payloadOf(blocks: Buffer): string {
    const text = blocks.toString('latin1');
    let out = '';
    let index = 0;
    while (index < text.length) {
        const start = text.indexOf('\u001b_G', index);
        if (start < 0) break;
        const end = text.indexOf('\u001b\\', start);
        if (end < 0) break;
        const semicolon = text.indexOf(';', start);
        if (semicolon >= 0 && semicolon < end) out += text.slice(semicolon + 1, end);
        index = end + 2;
    }
    return out;
}

function imageKey(keys: Record<string, string>): string | undefined {
    const id = keys.i ?? keys.I;
    return id === undefined || id === '' ? undefined : id;
}
