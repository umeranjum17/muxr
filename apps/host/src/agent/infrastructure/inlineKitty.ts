/**
 * Kitty control blocks carried inline in Herdr's app terminal stream.
 *
 * Herdr transmits a direct-graphics image's pixels as a leased file, but places
 * and deletes it with APC commands written into the full-app output frame. This
 * scanner hands back each complete block so the bridge can translate those
 * commands to the image ids the phone actually holds.
 *
 * It is deliberately not a terminal emulator: everything that is not a Kitty
 * APC block is opaque.
 */

const ESC = 0x1b;
const APC_INTRODUCER = 0x5f; // ESC _
const STRING_TERMINATOR = 0x5c; // ESC \
const KITTY_MARKER = 0x47; // 'G'

export type InlineKittyBlock = {
    /** Verbatim APC block, `ESC _ G ... ESC \`, ready to forward. */
    bytes: Buffer;
    /** Parsed control keys, e.g. `a`, `i`, `d`, `p`. */
    keys: Record<string, string>;
};

/** One instance per stream; an APC block can be split across socket frames. */
export class InlineKittyScanner {
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
            if (data[escape + 1] === APC_INTRODUCER) {
                const end = terminatorAt(data, escape + 2);
                if (end < 0) { this.carry = Buffer.from(data.subarray(escape)); return blocks; }
                const block = data.subarray(escape, end + 2);
                if (data[escape + 2] === KITTY_MARKER) {
                    blocks.push({ bytes: Buffer.from(block), keys: parseKeys(block) });
                }
                index = end + 2;
                continue;
            }
            index = escape + 2;
        }
        return blocks;
    }
}

function terminatorAt(data: Buffer, from: number): number {
    for (let index = from; index + 1 < data.length; index += 1) {
        if (data[index] === ESC && data[index + 1] === STRING_TERMINATOR) return index;
    }
    return -1;
}

/** `ESC _ G a=p,i=7 ESC \` -> `{ a: 'p', i: '7' }`. */
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
