import { relayChannelSocketUrl } from './controlPlaneUrl.js';

/**
 * Live terminal channel: the wire format for driving a herdr pane from a client.
 *
 * Same shape as the preview channel: the host joins a channel as `machine`, the
 * client joins the same channel as `client`, and the relay pipes NDJSON text
 * frames between them without parsing them. Kept off the envelope path on
 * purpose -- terminal frames are a video-like stream and would evict the whole
 * replay log in seconds.
 *
 * The frames ARE herdr's own terminal-stream protocol: the host spawns
 * `herdr terminal session control <pane>` and forwards its stdout verbatim;
 * client input is written to that process's stdin verbatim. herdr's first
 * frames repaint the whole screen, so there is no separate "ready" handshake --
 * the relay holds those frames until the client connects.
 */

/** Either direction, verbatim herdr protocol. host->client output. */
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
 * host -> client: an image to render inline in the terminal view.
 *
 * Pushed when an agent runs `muxr show-image` in the pane. Strictly ephemeral:
 * it rides only this live channel -- never replayed, never persisted on the
 * client -- so it behaves like terminal output, not a file.
 */
export interface TerminalImageFrame {
    type: 'terminal.image';
    /** Sender-chosen identity; a re-push with the same id replaces the image. */
    id: string;
    mime: string;
    /** base64-encoded image bytes. */
    bytes: string;
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

export type TerminalClientFrame = TerminalInputFrame | TerminalResizeFrame | TerminalScrollFrame;
export type TerminalHostFrame = TerminalOutputFrame | TerminalClosedFrame | TerminalScrollStateFrame | TerminalImageFrame;

/** Random channel id. The relay pairs the two sockets quoting the same one. */
export function newTerminalChannel(): string {
    return `tm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Both ends build the terminal socket URL from the same relay URL they already
 * use, so a terminal reaches exactly as far as the session link does.
 */
export function terminalSocketUrl(
    relayUrl: string,
    options: { machineId: string; channel: string; role: 'machine' | 'client'; token?: string },
): string {
    return relayChannelSocketUrl(relayUrl, 'terminal', options);
}
