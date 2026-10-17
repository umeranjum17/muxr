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
 * until they type to the pane, tap Latest or switch panes; new output and
 * answers appearing do not move it.
 *
 * The surface moves in whole rows, so one drag line is exactly one row to the
 * surface or to Herdr, never a share of both. Travel under a row is carried into
 * the next drag line rather than dropped. A fraction of overflow stays hidden at
 * the top limit instead of leaving a blank row above the grid.
 *
 * Proof (features/terminalFloorLab.mjs drives these on a 270 dp phone, font 20):
 * - floor-pan with the keyboard closed, a downward drag shows the grid's top rows before the pane scrolls; an upward drag brings the status lines back. Typing to the pane follows the cursor again.
 * - floor-follow with the keyboard up, the box ends on the cursor's row (the prompt), so the reply above it shows; the status lines under the prompt are off the bottom.
 * - floor-whole-rows while the grid is taller than its box, the box's bottom row is never cut in half at its bottom edge. The hard case is a program whose cursor is near the top (`nvim -u NONE notes.txt` on a 100-line file), so the box shows the grid's top rows.
 *
 * Gotchas:
 * - A renderer keeps the grid it attached at, so after a font change the grid can stay taller than the floor asks for; the pan covers every row it drew.
 * - Whole rows come from terminalShownHeight in terminalFloor.ts: the screen clips a floor-tall surface to whole rows and hands the pan that height.
 * - A slow drag (600 ms) pans about one row; a quick stroke carries the whole stroke.
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
     * Drag travel in Herdr's direction (positive goes back). Returns the whole
     * lines the surface could not take, for the pane's own scroll; a fraction of
     * a line is kept for the next call.
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
export function createTerminalPan(setOffset: (offset: number) => void, onAbsorbed: (rows: number) => void): TerminalPan {
    let layout: TerminalPanLayout = { surfaceHeight: 0, boxHeight: 0, rowHeight: 0 };
    let cursor: number | undefined;
    let held: number | undefined;
    let attached: string | undefined;
    let shown = 0;
    let carry = 0;

    /** Whole rows in `px`, so the surface stops on a row line and Herdr's lines stay whole. */
    const wholeRows = (px: number): number => (layout.rowHeight > 0
        ? Math.floor(px / layout.rowHeight + 1e-9) * layout.rowHeight
        : px);
    const overflow = (): number => wholeRows(Math.max(0, layout.surfaceHeight - layout.boxHeight));
    const clamp = (offset: number): number => wholeRows(Math.min(overflow(), Math.max(0, offset)));
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
            const travel = carry + lines;
            const rows = Math.trunc(travel);
            carry = travel - rows;
            if (rows === 0) return 0;
            if (layout.rowHeight <= 0) return rows;
            const from = held ?? shown;
            const to = clamp(from + rows * layout.rowHeight);
            if (to !== from) {
                held = to;
                show();
            }
            const moved = Math.round((to - from) / layout.rowHeight);
            if (moved !== 0) onAbsorbed(Math.abs(moved));
            return rows - moved;
        },
        follow() {
            if (held === undefined) return;
            held = undefined;
            show();
        },
        attach(pane) {
            if (pane !== attached) {
                held = undefined;
                carry = 0;
            }
            attached = pane;
            cursor = undefined;
            show();
        },
    };
}
