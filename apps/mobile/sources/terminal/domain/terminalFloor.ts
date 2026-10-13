import { FONT_STEPS, clampFontIndex } from './fontSteps';

/**
 * The fewest rows any pane is ever given. A program may not survive a short
 * grid: OpenCode 1.18 and 1.19 die (a bun panic) at 21 rows or fewer on a
 * 37-column grid, and the keyboard on a 270 dp phone leaves 7. A narrower grid
 * needs more: 31 columns dies at 22 rows, 26 at 24, 22 at 24, while 26 x 30 and
 * 22 x 40 live, so a grid also gets rows enough for MIN_TERMINAL_CELLS cells.
 * Below this the terminal keeps its rows and shows their bottom, where every
 * agent's prompt is, instead of handing the pane a smaller grid.
 */
export const MIN_TERMINAL_ROWS = 24;
const MIN_TERMINAL_CELLS = 900;
/**
 * Until a renderer reports its row height, its line is estimated from the font
 * size. The ratio errs tall, so the first grid is never short; the report then
 * replaces the estimate with the real row height.
 */
const ESTIMATED_LINE_PER_FONT_SIZE = 1.5;

/** The drawn row height once a renderer reports it, else the estimate from the font size. */
export function terminalLineHeight(input: { fontIndex: number; drawnRowHeight?: number }): number {
    return input.drawnRowHeight ?? FONT_STEPS[clampFontIndex(input.fontIndex)]! * ESTIMATED_LINE_PER_FONT_SIZE;
}

/**
 * The height the terminal box is given at least. Both renderers turn the box
 * into their grid, so the floor is a box this tall and the screen shows its
 * bottom. A whole extra point keeps layout rounding from flooring it to one row
 * fewer.
 */
export function terminalSurfaceHeight(input: { boxHeight: number; cols?: number; fontIndex: number; drawnRowHeight?: number }): number {
    const rowHeight = terminalLineHeight(input);
    const rows = Math.max(MIN_TERMINAL_ROWS, input.cols !== undefined && input.cols > 0 ? Math.ceil(MIN_TERMINAL_CELLS / input.cols) : 0);
    return Math.max(input.boxHeight, rows * rowHeight + 1);
}
