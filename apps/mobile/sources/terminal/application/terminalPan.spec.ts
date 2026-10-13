import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { createTerminalPan } from './terminalPan';

/** A Herdr diff frame: a synchronized repaint that ends by putting the cursor back. */
function herdrFrame(text: string, cursorRow: number, cursor: 'h' | 'l' = 'h'): string {
    const bytes = `\x1b[?2026h\x1b[?25l\x1b[${cursorRow};1H${text}\x1b[0m\x1b[${cursorRow};3H\x1b[?25${cursor}\x1b[?2026l\x1b[${cursorRow};3H\x1b[?25${cursor}`;
    return encodeBase64(new TextEncoder().encode(bytes));
}

describe('a grid taller than its box', () => {
    it('follows the cursor, pans before the pane scrolls, and holds where the user put it until they type', () => {
        let offset = 0;
        const pan = createTerminalPan((next) => { offset = next; });
        const row = 20;
        // 25 floor rows drawn 20 tall; the keyboard leaves room for 7.
        pan.layout({ surfaceHeight: 25 * row + 1, boxHeight: 7 * row, rowHeight: row });
        expect(offset).toBe(0);

        // An agent's prompt is on row 14 (1-based), its reply right above:
        // the box ends on that row, not on the status lines under it.
        pan.frame(herdrFrame('> ', 14));
        const following = 25 * row + 1 - 14 * row;
        expect(offset).toBe(following);

        // A drag back pans the surface; the pane is not scrolled.
        expect(pan.pan(3)).toBe(0);
        expect(offset).toBe(following + 3 * row);
        // Past the grid's top row, what is left scrolls the pane.
        expect(pan.pan(10)).toBe(6);
        expect(offset).toBe(18 * row + 1);

        // New output does not take the box away from where the user put it.
        pan.frame(herdrFrame('streamed reply', 15));
        expect(offset).toBe(18 * row + 1);

        // Typing follows the cursor again.
        pan.follow();
        expect(offset).toBe(25 * row + 1 - 15 * row);

        // A hidden cursor is parked, not where the program writes.
        pan.frame(herdrFrame('', 3, 'l'));
        expect(offset).toBe(25 * row + 1 - 15 * row);

        // Forward travel shows the bottom rows first, then scrolls the pane.
        expect(pan.pan(-12)).toBe(-2);
        expect(offset).toBe(0);

        // A question's answers sit on the bottom rows: appearing, they bring
        // the bottom back from wherever the user dragged.
        expect(pan.pan(5)).toBe(0);
        expect(offset).toBe(5 * row);
        pan.layout({ surfaceHeight: 25 * row + 1, boxHeight: 7 * row, rowHeight: row, holdBottom: true });
        expect(offset).toBe(0);

        // The keyboard closes and the whole grid fits: nothing pans.
        pan.layout({ surfaceHeight: 25 * row + 1, boxHeight: 26 * row, rowHeight: row });
        expect(offset).toBe(0);
        expect(pan.pan(4)).toBe(4);
    });
});
