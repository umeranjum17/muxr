/**
 * Terminal private-mode tracking for phone scroll.
 *
 * A full-screen agent turns on alternate screen and mouse reporting. When it
 * exits or crashes without clearing those modes, Herdr keeps no scrollback and
 * still accepts wheel reports — bash then echoes SGR sequences like `64;19;6M`.
 * Muxr tracks the modes from output, turns a scroll into wheel reports only
 * while mouse reporting is known on, and restores normal screen/mouse once no
 * program of the pane is left holding those modes.
 */

/** Leave alternate screen and every common mouse-reporting mode. */
export const MODE_RESET_CSI = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';

/** Modes that make a wheel report meaningful to the program. */
const MOUSE_MODES = new Set([1000, 1002, 1003, 1005, 1006, 1015, 1016]);
/** Alternate-screen private modes (DECSET/DECRST). */
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

export type TerminalModeState = {
    /** undefined until a DECSET/DECRST for a mouse mode is seen. */
    mouseReporting: boolean | undefined;
    /** undefined until a DECSET/DECRST for alternate screen is seen. */
    alternateScreen: boolean | undefined;
};

export function freshTerminalModes(): TerminalModeState {
    return { mouseReporting: undefined, alternateScreen: undefined };
}

/**
 * CSI private-mode set/reset: ESC [ ? Pm [; Pm]* h/l (and the CSI ?= form).
 * Incomplete sequences at the end of a chunk are ignored; the next chunk
 * carries a full sequence from the program.
 */
const PRIVATE_MODE = /\x1b\[\?([\d;]+)([hl])/g;

export function applyPrivateModeBytes(state: TerminalModeState, text: string): TerminalModeState {
    let mouseReporting = state.mouseReporting;
    let alternateScreen = state.alternateScreen;
    PRIVATE_MODE.lastIndex = 0;
    for (const match of text.matchAll(PRIVATE_MODE)) {
        const on = match[2] === 'h';
        for (const part of match[1]!.split(';')) {
            if (part === '') continue;
            const mode = Number(part);
            if (!Number.isInteger(mode)) continue;
            if (MOUSE_MODES.has(mode)) mouseReporting = on;
            if (ALT_SCREEN_MODES.has(mode)) alternateScreen = on;
        }
    }
    if (mouseReporting === state.mouseReporting && alternateScreen === state.alternateScreen) return state;
    return { mouseReporting, alternateScreen };
}

/**
 * Wheel reports go to the program only while mouse reporting is known on.
 * Herdr turns a scroll into wheel reports for the program whenever it owns no
 * scrollback, so an off — or not yet learned — mode must not expand one.
 */
export function shouldSendWheelReports(
    herdrOwnsScroll: boolean | undefined,
    mouseReporting: boolean | undefined,
): boolean {
    return herdrOwnsScroll === false && mouseReporting === true;
}

/**
 * The pane still shows alternate-screen or mouse modes a fullscreen program
 * turned on and left behind.
 */
export function shouldResetStaleModes(modes: TerminalModeState): boolean {
    return modes.mouseReporting === true || modes.alternateScreen === true;
}

/**
 * After attach we may have missed the DECSET that left modes on. When Herdr
 * still has no scrollback and no mode has been seen yet, probe once.
 */
export function shouldProbeModeRestore(
    herdrOwnsScroll: boolean | undefined,
    modes: TerminalModeState,
): boolean {
    if (herdrOwnsScroll !== false) return false;
    if (shouldResetStaleModes(modes)) return true;
    // Unknown modes + no scrollback: likely a crashed fullscreen program.
    return modes.mouseReporting === undefined && modes.alternateScreen === undefined;
}
