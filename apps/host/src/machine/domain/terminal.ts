/**
 * The link-side terminal seam: what a machine needs to attach one pane whose
 * client pipe is already open (a byokit link stream), without reaching into
 * the agent module. The terminal manager satisfies the port structurally.
 */

/** One pane's host↔client line pipe: NDJSON terminal frames each way, whole
 *  lines out of `onLine`. The relay channel socket and the byokit link stream
 *  both speak it, so the pane machinery cannot tell the transports apart. */
export interface TerminalPipe {
    /** False once the transport is gone; a closed pipe must not carry frames. */
    readonly isOpen: boolean;
    /** One host→client NDJSON line. */
    send(line: string): void;
    /** Each complete client→host NDJSON line, in order. Returns the unsubscribe. */
    onLine(listener: (line: string) => void): () => void;
    /** The transport ended; the pane's control stream goes with it. */
    onEnd(listener: () => void): () => void;
    close(): void;
}

/** Link stream args for a terminal pane, as the device opens the stream with them. */
export type LinkTerminalAttachParams = {
    requestId: string;
    sessionId: string;
    channel: string;
    cols: number;
    rows: number;
    mode?: 'control' | 'observe';
    takeover?: boolean;
};

/** The slice of the terminal manager a link stream needs: attach with a pipe already open. */
export type LinkTerminalPort = {
    attach(params: LinkTerminalAttachParams & { deviceId: string; socket: TerminalPipe }): Promise<{ paneId: string }>;
};

const ATTACH_FAILURE_CODES: Record<string, true> = {
    'e2ee-required': true,
    takeover: true,
    'socket-timeout': true,
    'socket-error': true,
    'ticket-invalid': true,
    'device-revoked': true,
    'ticket-issue-failed': true,
    'agent-not-ready': true,
    unavailable: true,
};

/** The machine's own words for why an attach failed, as a stable code the device can act on. */
export function attachFailureCode(error: unknown): string {
    const value = error as { code?: unknown; status?: unknown };
    if (typeof value.code === 'string' && ATTACH_FAILURE_CODES[value.code] === true) return value.code;
    if (value.status === 401) return 'ticket-invalid';
    if (value.status === 403) return 'device-revoked';
    if (typeof value.status === 'number') return 'ticket-issue-failed';
    const message = error instanceof Error ? error.message : String(error);
    if (/relay|socket|websocket|unexpected server response/i.test(message)
        || typeof value.code === 'string' && /^E(?:CONN|HOST|NET|PIPE|TIMEDOUT)/.test(value.code)) {
        return 'socket-error';
    }
    if (/(?:pane|session).*(?:not found|missing)|no current/i.test(message)) return 'agent-not-ready';
    return 'unavailable';
}
