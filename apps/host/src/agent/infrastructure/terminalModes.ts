/**
 * Terminal private-mode tracking for phone scroll.
 *
 * A full-screen agent turns on alternate screen and mouse reporting. When it
 * exits or crashes without clearing those modes, Herdr keeps no scrollback and
 * still accepts wheel reports — bash then echoes SGR sequences like `64;19;6M`.
 * Muxr tracks the modes from output, sends wheel reports only while mouse
 * reporting is not known-off, and restores normal screen/mouse when the shell
 * alone is left holding those modes.
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
 * Wheel reports go to the program when Herdr has no scrollback, unless mouse
 * reporting is known off. Unknown (attach mid-program) keeps the old expand
 * path so a live agent still gets a fling as many notches.
 */
export function shouldSendWheelReports(
    herdrOwnsScroll: boolean | undefined,
    mouseReporting: boolean | undefined,
): boolean {
    return herdrOwnsScroll === false && mouseReporting !== false;
}

/**
 * Shell alone still showing alternate-screen or mouse modes — the foreground
 * program left without clearing them.
 */
export function shouldResetStaleModes(
    modes: TerminalModeState,
    foregroundIsShellOnly: boolean,
): boolean {
    return foregroundIsShellOnly && (modes.mouseReporting === true || modes.alternateScreen === true);
}

/**
 * After attach we may have missed the DECSET that left modes on. When Herdr
 * still has no scrollback and only the shell is foreground, probe a resetonce.
 */
export function shouldProbeModeRestore(
    herdrOwnsScroll: boolean | undefined,
    modes: TerminalModeState,
    foregroundIsShellOnly: boolean,
): boolean {
    if (!foregroundIsShellOnly || herdrOwnsScroll !== false) return false;
    if (shouldResetStaleModes(modes, true)) return true;
    // Unknown modes + no scrollback + shell only: likely a crashed agent.
    return modes.mouseReporting === undefined && modes.alternateScreen === undefined;
}
