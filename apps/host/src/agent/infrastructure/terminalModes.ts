/**
 * Whose pane it is decides what a phone scroll may do.
 *
 * A full-screen program turns on alternate screen and mouse reporting; when it
 * exits or crashes without clearing them, Herdr keeps no scrollback for the
 * pane and still forwards a scroll to it as mouse-wheel reports — which the
 * shell then echoes as `64;19;6M` into its command line. Herdr's output frames
 * do not carry those modes back, but its process list names the pane's
 * foreground: muxr casts a wheel only while a program, not the pane's own
 * shell, holds the pane, and clears what a program left once its pid is gone.
 */

/** Leave alternate screen and every common mouse-reporting mode. */
export const MODE_RESET_CSI = '\x1b[?47l\x1b[?1047l\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l';

/**
 * A wheel report may go only to a program: the pane's own shell never takes
 * one. Before a probe has answered, the pane is taken to hold a program, which
 * is what every pane did before this check existed.
 */
export function wheelReportsAllowed(foregroundPids: number[] | undefined): boolean {
    return foregroundPids === undefined || foregroundPids.length > 0;
}
