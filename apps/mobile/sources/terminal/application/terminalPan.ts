import { decodeBase64 } from '@/encryption/base64';

/**
 * Which rows of a grid taller than its box are in view.
 *
 * The grid can be taller than the box: it never goes below its floor
 * (terminalFloor.ts), so the keyboard or a large font leaves rows outside it.
 * By default the box follows the pane's cursor -- the row the program writes
 * at, which for an agent is its prompt with the newest reply right above, and
 * for a shell is the last line -- so that row is the box's last one, and a grid
 * with no cursor yet shows its bottom rows. The terminal's own drag reaches the
 * rest: the surface takes the travel while it can move that way, and only what
 * is left scrolls the pane in Herdr. A drag holds the box where the user put it
 * until they type to the pane, tap Latest or switch panes; new output does not
 * move it. Answers to a question appearing bring the box back to the cursor once.
 *
 * The surface moves in whole rows. A grid that overflows by a fraction of a row
 * leaves that fraction blank above its top row, so one drag line is exactly one
 * row to the surface or to Herdr, never a share of both.
 *
 * Herdr ends every frame by putting the cursor back (`ESC[row;colH`, then
 * showing or hiding it), so the row comes from the frame itself on both
 * renderers; the native one exposes no cursor of its own. A hidden cursor is
 * parked, not where the program writes, so its frame leaves the row in place.
 */

/**
 * Herdr's frame trailer: the cursor's 1-based row and column, then the cursor
 * shown. A hidden cursor is parked, not where the program writes, so its frame
 * leaves the last shown row in place.
 */
const CURSOR_TRAILER = /\x1b\[(\d+);\d+H\x1b\[\?25h$/;
/** The trailer is a few dozen bytes; decode only the end of a frame. */
const TAIL_BASE64_CHARS = 64;

export interface TerminalPanLayout {
    /** The surface the grid is drawn in; at least the floor, so it can overflow the box. */
    surfaceHeight: number;
    boxHeight: number;
    rowHeight: number;
}

export interface TerminalPan {
    /** A frame from Herdr: its trailer says where the cursor now is. */
    frame: (base64: string) => void;
    layout: (layout: TerminalPanLayout) => void;
    /**
     * Drag travel in Herdr's direction (positive goes back). Returns what the
     * surface could not take, for the pane's own scroll.
     */
    pan: (lines: number) => number;
    /** The user typed to the pane or tapped Latest: follow its cursor again. */
    follow: () => void;
    /**
     * A channel attached to `pane`: forget the previous cursor until its own
     * frame names one, and drop a drag only if it was for another pane.
     */
    attach: (pane: string) => void;
}

/** The last cursor row (0-based) a frame's trailer names, if it ends with one. */
function cursorRow(base64: string): number | undefined {
    const tail = base64.slice(Math.max(0, base64.length - TAIL_BASE64_CHARS) & ~3);
    let text = '';
    try {
        for (const byte of decodeBase64(tail)) text += String.fromCharCode(byte);
    } catch {
        return undefined;
    }
    const match = CURSOR_TRAILER.exec(text);
    return match === null ? undefined : Number(match[1]) - 1;
}

/**
 * `setOffset` gets how far the surface sits below its bottom-aligned place, in
 * points: 0 shows the grid's bottom rows, the overflow shows its top ones.
 */
export function createTerminalPan(setOffset: (offset: number) => void): TerminalPan {
    let layout: TerminalPanLayout = { surfaceHeight: 0, boxHeight: 0, rowHeight: 0 };
    let cursor: number | undefined;
    let held: number | undefined;
    let attached: string | undefined;
    let shown = 0;

    /** Whole rows past the box, so the surface stops on a row line and Herdr's lines stay whole. */
    const overflow = (): number => {
        const excess = Math.max(0, layout.surfaceHeight - layout.boxHeight);
        return layout.rowHeight > 0 ? Math.ceil(excess / layout.rowHeight) * layout.rowHeight : excess;
    };
    const clamp = (offset: number): number => Math.min(overflow(), Math.max(0, offset));
    const followed = (): number => (cursor === undefined || layout.rowHeight <= 0
        ? 0
        : clamp(layout.surfaceHeight - (cursor + 1) * layout.rowHeight));
    const show = (): void => {
        if (overflow() === 0) held = undefined;
        const next = held ?? followed();
        if (next === shown) return;
        shown = next;
        setOffset(next);
    };

    return {
        frame(base64) {
            const row = cursorRow(base64);
            if (row === undefined || row === cursor) return;
            cursor = row;
            show();
        },
        layout(next) {
            layout = next;
            if (held !== undefined) held = clamp(held);
            show();
        },
        pan(lines) {
            if (lines === 0 || layout.rowHeight <= 0 || overflow() === 0) return lines;
            const from = held ?? shown;
            const to = clamp(from + lines * layout.rowHeight);
            if (to === from) return lines;
            held = to;
            show();
            return Math.round(lines - (to - from) / layout.rowHeight);
        },
        follow() {
            if (held === undefined) return;
            held = undefined;
            show();
        },
        attach(pane) {
            if (pane !== attached) held = undefined;
            attached = pane;
            cursor = undefined;
            show();
        },
    };
}
