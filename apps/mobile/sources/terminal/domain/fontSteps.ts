/** Text zoom ladder for panes that reflow (terminal, document viewer). Shared so the copies cannot drift. */
export const FONT_STEPS = [7, 8, 10, 12, 14, 17, 20] as const;
export const DEFAULT_FONT_INDEX = 3;

export function clampFontIndex(index: number): number {
    return Math.max(0, Math.min(FONT_STEPS.length - 1, index));
}
