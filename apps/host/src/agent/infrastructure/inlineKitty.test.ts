import { describe, expect, it } from 'vitest';
import { InlineImageStore, InlineKittyScanner } from './inlineKitty.js';

// One flow check: an image a program wrote to its own PTY, split across socket
// frames the way Herdr delivers it, must come back with the cell it landed on,
// its pixels held once, and its placement routable.
describe('inline Kitty in the app stream', () => {
    it('follows the cursor, joins chunks, and prepares pixels once', async () => {
        const scanner = new InlineKittyScanner();
        const store = new InlineImageStore();

        const head = Buffer.from('\u001b[?2004l\u001b[7;3Hhello \u001b_Ga=t,f=32,s=2,v=2,i=42,m=1;AAAA\u001b\\');
        const tail = Buffer.from('\u001b_Gm=0;BBBB\u001b\\\u001b[9;5H\u001b_Ga=p,i=42,c=4,r=2;\u001b\\');

        const first = scanner.scan(head.subarray(0, head.length - 3));
        expect(first).toHaveLength(0); // the block is still incomplete

        const rest = scanner.scan(Buffer.concat([head.subarray(head.length - 3), tail]));
        expect(rest.map((block) => block.keys.a ?? '')).toEqual(['t', '', 'p']);
        expect(rest[0]?.row).toBe(7);
        expect(rest[0]?.col).toBe(3);

        expect(store.admit(rest[0]!)).toBe(true);
        expect(store.admit(rest[1]!)).toBe(true);

        const placement = rest[2]!;
        expect(store.admit(placement)).toBe(false); // placements are not image data
        expect(placement.row).toBe(9);
        expect(placement.col).toBe(5);
        const prepared = await store.prepared(placement, async (rgba, control) => ({
            bytes: rgba.length,
            control,
        }));
        // AAAA + BBBB decode to six bytes; the control keys come from the
        // transmission, not the placement, so the encoder can size the image.
        expect(prepared).toEqual({ bytes: 6, control: 's=2,v=2,i=42' });

        // A second placement of the same image reuses the prepared frame.
        let prepareCalls = 0;
        await store.prepared(placement, async () => { prepareCalls += 1; return {}; });
        expect(prepareCalls).toBe(0);
    });
});
