/** Text zoom ladder for panes that reflow (terminal, document viewer). Shared so the copies cannot drift. */
export const FONT_STEPS = [7, 8, 10, 12, 14, 17, 20] as const;
export const DEFAULT_FONT_INDEX = 3;

export function clampFontIndex(index: number): number {
    if (!Number.isFinite(index)) return DEFAULT_FONT_INDEX;
    return Math.max(0, Math.min(FONT_STEPS.length - 1, Math.trunc(index)));
}

/** Faces the browser terminal can draw. The phone's native terminal has its own
 *  built-in face, so this choice only reaches the web. */
export const TERMINAL_FONTS = {
    system: { name: 'System', family: 'Menlo, Monaco, "Courier New", monospace' },
    plex: { name: 'IBM Plex Mono', family: 'IBMPlexMono-Regular, monospace' },
} as const;
export type TerminalFont = keyof typeof TERMINAL_FONTS;
