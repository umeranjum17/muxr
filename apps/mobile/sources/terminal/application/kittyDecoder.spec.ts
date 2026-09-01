import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    MAX_KITTY_IMAGE_BYTES,
    createKittyDecoderState,
    inflateZlib,
    materializeKittyCommands,
    splitKittyFrame,
} from './kittyDecoder';

if (typeof globalThis.DecompressionStream !== 'function') {
    class DecompressionStreamPolyfill {
        readonly readable: ReadableStream<Uint8Array>;
        readonly writable: WritableStream<Uint8Array>;
        constructor(format: string) {
            if (format !== 'deflate') throw new TypeError(format);
            const chunks: Uint8Array[] = [];
            const transform = new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk) {
                    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
                },
                flush(controller) {
                    let total = 0;
                    for (const chunk of chunks) total += chunk.byteLength;
                    const data = new Uint8Array(total);
                    let offset = 0;
                    for (const chunk of chunks) {
                        data.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    controller.enqueue(inflateSync(data));
                },
            });
            this.readable = transform.readable;
            this.writable = transform.writable;
        }
    }
    Object.assign(globalThis, { DecompressionStream: DecompressionStreamPolyfill });
}

function kittyFrame(rgba: Uint8Array, width: number, height: number, imageId: number, chunkChars: number): Uint8Array {
    const encoded = deflateSync(rgba).toString('base64');
    const parts = ['\x1b7', '\x1b_Ga=d,d=A,q=2;\x1b\\', '\x1b[2;3H'];
    for (let offset = 0; offset < encoded.length; offset += chunkChars) {
        const chunk = encoded.slice(offset, offset + chunkChars);
        const more = offset + chunkChars < encoded.length ? 1 : 0;
        const header = offset === 0
            ? `a=T,f=32,s=${width},v=${height},i=${imageId},c=4,r=2,t=d,o=z,m=${more}`
            : `m=${more}`;
        parts.push(`\x1b_G${header};${chunk}\x1b\\`);
    }
    parts.push('\x1b8');
    return new TextEncoder().encode(parts.join(''));
}

describe('web Kitty decoder', () => {
    it('materializes a multi-chunk host frame, deletes it, and rejects bad payloads', async () => {
        const rgba = new Uint8Array(32 * 32 * 4);
        for (let index = 0; index < rgba.length; index += 4) {
            rgba[index] = 16;
            rgba[index + 1] = 32;
            rgba[index + 2] = 64;
            rgba[index + 3] = 255;
        }
        const frame = kittyFrame(rgba, 32, 32, 7, 24);
        expect(frame.includes(0x1b) && new TextDecoder().decode(frame).split('\x1b_G').length).toBeGreaterThan(3);

        const state = createKittyDecoderState();
        const split = splitKittyFrame(frame, state);
        expect(split.error).toBeUndefined();
        expect(new TextDecoder().decode(split.ansi)).toContain('\x1b[2;3H');
        expect(split.commands).toEqual([
            { kind: 'delete-all' },
            expect.objectContaining({ kind: 'transmit', id: 7, width: 32, height: 32, col: 2, row: 1, cols: 4, rows: 2 }),
        ]);

        const image = await materializeKittyCommands(split.commands, inflateZlib);
        expect(image.error).toBeUndefined();
        expect(image.deleteAll).toBe(true);
        expect(image.placements).toEqual([expect.objectContaining({ id: 7, width: 32, height: 32, col: 2, row: 1 })]);
        expect(image.placements[0]?.rgba).toEqual(rgba);

        // Host retire/close frames are graphics:false but still decode. The web
        // canvas path clears placements from this result; APC must not leak to xterm.
        const retire = splitKittyFrame(new TextEncoder().encode('\x1b_Ga=d,d=A;\x1b\\'), state);
        expect(retire.error).toBeUndefined();
        expect(retire.commands).toEqual([{ kind: 'delete-all' }]);
        expect(new TextDecoder().decode(retire.ansi).includes('\x1b_G')).toBe(false);
        const retired = await materializeKittyCommands(retire.commands, inflateZlib);
        expect(retired.deleteAll).toBe(true);
        expect(retired.placements).toEqual([]);

        const bad = splitKittyFrame(new TextEncoder().encode('\x1b_Ga=T,f=32,s=2,v=2,i=1,t=d,o=z,m=0;@@@@\x1b\\'), createKittyDecoderState());
        expect(bad.error).toBe('malformed');

        const huge = splitKittyFrame(new TextEncoder().encode(`\x1b_Ga=T,f=32,s=1,v=1,i=1,m=0;${'A'.repeat(5000)}\x1b\\`), createKittyDecoderState());
        expect(huge.error).toBe('oversized');

        const unknown = splitKittyFrame(new TextEncoder().encode('\x1b_Ga=q,i=1;\x1b\\'), createKittyDecoderState());
        expect(unknown.error).toBe('unsupported');

        const prefix = createKittyDecoderState();
        expect(splitKittyFrame(new Uint8Array([0x1b]), prefix).ansi).toEqual(new Uint8Array(0));
        const continued = splitKittyFrame(new TextEncoder().encode('_Ga=d,d=A;\x1b\\ok'), prefix);
        expect(continued.error).toBeUndefined();
        expect(continued.commands).toEqual([{ kind: 'delete-all' }]);
        expect(new TextDecoder().decode(continued.ansi)).toBe('ok');

        const trailing = splitKittyFrame(new TextEncoder().encode('\x1b_Ga=T,f=32,s=2,v=2,i=1,t=d,o=z,m=0;@@@@\x1b\\kept'), createKittyDecoderState());
        expect(trailing.error).toBe('malformed');
        expect(new TextDecoder().decode(trailing.ansi)).toBe('kept');

        const unterminated = new Uint8Array(MAX_KITTY_IMAGE_BYTES + 4);
        unterminated[0] = 0x1b;
        unterminated[1] = 0x5f;
        unterminated[2] = 0x47;
        expect(splitKittyFrame(unterminated, createKittyDecoderState()).error).toBe('oversized');
    });
});
