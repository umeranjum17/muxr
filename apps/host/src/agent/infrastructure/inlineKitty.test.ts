import { describe, expect, it } from 'vitest';
import { InlineImageStore, InlineKittyScanner } from './inlineKitty.js';

// One flow check: an image a program wrote to its own PTY, split across socket
// frames the way Herdr delivers it, must come back with the cell it landed on,
// its pixels held once, and its placement routable.
describe('inline Kitty in the app stream', () => {
    it('follows the cursor, joins chunks, and prepares pixels once', async () => {
        const scanner = new InlineKittyScanner();
        const store = new InlineImageStore();

        const head = Buffer.from('\u001b[?2004l\u001b[7;3Hhello \u001b_Ga=t,f=32,s=2,v=2,i=42,m=1;AAAAAAAA\u001b\\');
        const tail = Buffer.from('\u001b_Gm=0;AAAAAAAAAAAAAA==\u001b\\\u001b[9;5H\u001b_Ga=p,i=42,c=4,r=2;\u001b\\');

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
        // The split payload decodes to 16 RGBA bytes; the control keys come
        // from the transmission, not the placement, so the encoder can size it.
        expect(prepared).toEqual({ bytes: 16, control: 's=2,v=2,i=42' });

        // A second placement of the same image reuses the prepared frame.
        let prepareCalls = 0;
        await store.prepared(placement, async () => { prepareCalls += 1; return {}; });
        expect(prepareCalls).toBe(0);
    });
    it('bounds retained bytes across interleaved transfers and still admits new images when full', async () => {
        // A cap small enough that a handful of tiny images saturate it.
        const cap = 250;
        const store = new InlineImageStore(cap);
        const bytes = store as unknown as { completeBytes: number; partialTotalBytes: number };
        const retained = (): number => bytes.completeBytes + bytes.partialTotalBytes;
        const scanner = new InlineKittyScanner();
        const chunk = (id: number, more: '0' | '1', payload: string) => scanner.scan(Buffer.from(
            `\u001b_Ga=t,f=32,s=2,v=2,i=${id},m=${more};${payload}\u001b\\`,
        ))[0]!;
        const place = (id: number) => scanner.scan(Buffer.from(`\u001b_Ga=p,i=${id},c=2,r=1;\u001b\\`))[0]!;

        // Two transfers in flight at once. Each already holds chunks of its own,
        // so counting only the other one's would let them pass the cap together.
        for (let round = 0; round < 6; round += 1) {
            for (const id of [1, 2]) {
                store.admit(chunk(id, '1', 'AAAAAAAA'));
                expect(retained()).toBeLessThanOrEqual(cap);
            }
        }
        store.admit(chunk(1, '0', 'AAAAAAAAAAAAAA=='));
        store.admit(chunk(2, '0', 'AAAAAAAAAAAAAA=='));
        expect(retained()).toBeLessThanOrEqual(cap);

        // Saturate with completed images, then transfer one more. A full cache
        // must evict its oldest image, not freeze and refuse every new frame.
        for (const id of [3, 4, 5]) {
            store.admit(chunk(id, '1', 'AAAAAAAA'));
            store.admit(chunk(id, '0', 'AAAAAAAAAAAAAA=='));
            expect(retained()).toBeLessThanOrEqual(cap);
        }
        const newest = await store.prepared(place(5), async (rgba) => rgba.length);
        expect(newest).toBe(16);
        // The oldest image is the one that left.
        expect(await store.prepared(place(1), async (rgba) => rgba.length)).toBeUndefined();
    });
});
