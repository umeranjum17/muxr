import { attachFailureCode } from '../../machine/index.js';

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
    detach(channel: string, deviceId?: string): Promise<void>;
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
    await port?.detach(command.channel, command.deviceId);
    return { ok: true, data: null };
}
