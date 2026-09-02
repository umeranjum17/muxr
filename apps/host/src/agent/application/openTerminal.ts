export type OpenTerminalCommand = {
    sessionId: string;
    channel: string;
    cols: number;
    rows: number;
    cellWidthPx?: number;
    cellHeightPx?: number;
    deviceId?: string;
    mode?: 'control' | 'observe';
    takeover?: boolean;
};

export type OpenTerminalResult =
    | { ok: true; data: { paneId: string } }
    | { ok: false; error: string; code?: string };

export interface TerminalPort {
    attach(command: OpenTerminalCommand): Promise<{ paneId: string }>;
    detach(channel: string, deviceId?: string): void;
}
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

function attachFailureCode(error: unknown): string {
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

export async function openTerminal(port: TerminalPort | undefined, command: OpenTerminalCommand): Promise<OpenTerminalResult> {
    if (port === undefined) return { ok: false, error: 'terminal: not available on this host', code: 'unavailable' };
    try {
        return { ok: true, data: await port.attach(command) };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: attachFailureCode(error),
        };
    }
}

export type CloseTerminalCommand = { channel: string; deviceId?: string };

export async function closeTerminal(port: TerminalPort | undefined, command: CloseTerminalCommand): Promise<OpenTerminalResult | { ok: true; data: null }> {
    port?.detach(command.channel, command.deviceId);
    return { ok: true, data: null };
}
