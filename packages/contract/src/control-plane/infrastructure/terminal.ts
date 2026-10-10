
/**
 * Live terminal channel: the wire format for driving a herdr pane from a client.
 *
 * The paired client and host exchange NDJSON frames over a byokit link stream;
 * the relay routes encrypted bytes without parsing them. Kept off the envelope path on
 * purpose -- terminal frames are a video-like stream and would evict the whole
 * replay log in seconds.
 *
 * Output and ordinary input use herdr's terminal-stream protocol through the
 * kit TerminalSession. The host adds scroll-state and bottom-completion frames;
 * terminal.bottom is consumed by muxr, never forwarded verbatim to herdr.
 * Herdr's first output frames repaint the whole screen.
 *
 * Bottom completion reads the actual Herdr viewport between bounded downward
 * steps. Where a program owns scrolling, the host instead targets the grid's
 * center with wheel reports sized to how far that program moves per report --
 * learned from its visible text -- and infers completion from repaint
 * quiescence or from the screen moving up on its own as the program follows new
 * output; it cannot confirm that program's transcript offset. The operation has
 * a deadline and reports catching-up if completion cannot be established.
 * Clients discard preceding gesture travel before requesting bottom. New input,
 * scrolling, resize or detach cancels host completion. The client also clears
 * pending status on repaint or transport retirement and ignores replies for
 * canceled or superseded request ids; a timeout result remains until canceled.
 */

/** host -> client: herdr terminal output. */
export interface TerminalOutputFrame {
    type: 'terminal.frame';
    /** base64-encoded ANSI bytes. */
    bytes: string;
    /** herdr extras: full repaint marker, stream position, dimensions. */
    full?: boolean;
    seq?: number;
    width?: number;
    height?: number;
    encoding?: string;
}

/** host -> client: the underlying stream ended. */
export interface TerminalClosedFrame {
    type: 'terminal.closed';
    reason?: string;
}

/**
 * host -> client: where herdr's own viewport sits in this pane's scrollback.
 *
 * The client cannot derive this. A `terminal.scroll` does not always move a
 * scrollback viewport: herdr only owns scrollback for a pane on the main
 * screen, and a program on the alternate screen (Claude Code, opencode and
 * every other full-screen harness) has no scrollback ring behind it at all --
 * herdr reports `maxOffsetFromBottom: 0` and forwards the finger to the
 * program as mouse-wheel reports instead. Counting the rows the phone asked
 * for therefore measures the request, never the result. Only herdr knows.
 */
export interface TerminalScrollStateFrame {
    type: 'terminal.scroll-state';
    /** Rows between the viewport and the live edge; 0 when it is at the bottom. */
    offsetFromBottom: number;
    /** Rows of scrollback herdr holds. 0 means herdr owns no scrolling here. */
    maxOffsetFromBottom: number;
}

/** client -> host input. `text` for typed text, `bytes` (base64) for raw keys. */
export interface TerminalInputFrame {
    type: 'terminal.input';
    text?: string;
    bytes?: string;
}

export interface TerminalResizeFrame {
    type: 'terminal.resize';
    cols: number;
    rows: number;
}

/** client -> host scroll. herdr owns the pane's scrollback, so the client
 *  forwards touch drags here instead of scrolling xterm locally (xterm's
 *  buffer only holds repaint diffs -- scrolling it shows garbage). */
export interface TerminalScrollFrame {
    type: 'terminal.scroll';
    direction: 'up' | 'down';
    lines: number;
    column?: number;
    row?: number;
}

export type TerminalClientFrame = TerminalInputFrame | TerminalResizeFrame | TerminalScrollFrame | { type: 'terminal.bottom'; requestId: string };
export type TerminalHostFrame = TerminalOutputFrame | TerminalClosedFrame | TerminalScrollStateFrame | { type: 'terminal.bottom-state'; requestId: string; state: 'complete' | 'catching-up' };

/** Random channel id for a link terminal stream. */
export function newTerminalChannel(): string {
    return `tm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
