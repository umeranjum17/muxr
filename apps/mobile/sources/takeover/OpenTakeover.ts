/**
 * Browser takeover, device half.
 *
 * agent-browser runs a WebSocket stream server on a loopback port of the
 * machine. The phone reaches it through the same relay preview tunnel the
 * dev-server preview uses: the tunnel forwards raw TCP without parsing it,
 * so the WebSocket handshake and frames ride through untouched. Frames
 * arrive as base64 JPEG, taps and keys go back as JSON.
 *
 * Security: nothing seen or typed here is logged or persisted. The user
 * clears 2FA and password walls over this channel.
 */

import { attachPreviewTunnel } from '@/preview';
import type { Point, StreamFrameMetadata } from './coordinates';

export interface StreamFrame {
    type: 'frame';
    data: string;
    metadata: StreamFrameMetadata;
}

/** Parses one stream message; anything that is not a frame is not ours. */
export function parseStreamFrame(raw: unknown): StreamFrame | undefined {
    if (typeof raw !== 'string') return undefined;
    try {
        const message = JSON.parse(raw) as Partial<StreamFrame>;
        if (message.type !== 'frame' || typeof message.data !== 'string') return undefined;
        const metadata = message.metadata;
        if (metadata === undefined || typeof metadata.deviceWidth !== 'number' || typeof metadata.deviceHeight !== 'number') return undefined;
        return {
            type: 'frame',
            data: message.data,
            metadata: {
                deviceWidth: metadata.deviceWidth,
                deviceHeight: metadata.deviceHeight,
                pageScaleFactor: typeof metadata.pageScaleFactor === 'number' && metadata.pageScaleFactor > 0 ? metadata.pageScaleFactor : 1,
            },
        };
    } catch {
        return undefined;
    }
}

export function touchMessage(eventType: 'touchStart' | 'touchMove' | 'touchEnd', point?: Point): string {
    return JSON.stringify({
        type: 'input_touch',
        eventType,
        touchPoints: point === undefined ? [] : [{ x: point.x, y: point.y }],
    });
}

export function keyMessage(eventType: 'keyDown' | 'keyUp', key: string, code: string): string {
    // Control keys dispatch on windowsVirtualKeyCode server-side: without it
    // Backspace/Enter payloads are ignored and the field never edits.
    const windowsVirtualKeyCode = key === 'Backspace' ? 8 : key === 'Enter' ? 13 : undefined;
    return JSON.stringify({
        type: 'input_keyboard',
        eventType,
        key,
        code,
        ...(windowsVirtualKeyCode !== undefined ? { windowsVirtualKeyCode } : {}),
        // A printable keyDown must carry the character itself: without the
        // text field the stream dispatches the key but inserts nothing into
        // a focused field (measured on a live input). Enter submits as CR.
        ...(eventType === 'keyDown' && [...key].length === 1 && key.charCodeAt(0) >= 32 ? { text: key } : eventType === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}),
    });
}

/** Back/forward are browser-level mouse buttons; coordinates are ignored by the browser for them. */
export function mouseMessage(eventType: 'mousePressed' | 'mouseReleased', point: Point, button: 'back' | 'forward'): string {
    return JSON.stringify({ type: 'input_mouse', eventType, x: point.x, y: point.y, button, clickCount: 1 });
}

/**
 * The stream port an agent advertises when it enables its browser stream:
 * the `ws://127.0.0.1:<port>` URL printed into its conversation.
 */
export function advertisedStreamPort(text: string): number | undefined {
    const match = /ws:\/\/127\.0\.0\.1:(\d{1,5})(?!\d)/.exec(text);
    if (match === null) return undefined;
    const port = Number(match[1]);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/** Reads the port out of `agent-browser stream enable --json` output. */
function parseEnablePort(stdout: string): number | undefined {
    try {
        const parsed = JSON.parse(stdout) as { port?: unknown };
        if (typeof parsed.port === 'number' && Number.isSafeInteger(parsed.port) && parsed.port >= 1 && parsed.port <= 65_535) return parsed.port;
    } catch {
        // Fall through to the regex for non-JSON output.
    }
    const port = Number(/"port"\s*:\s*(\d+)/.exec(stdout)?.[1]);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/** The bound port in `stream status --json` output; only when a stream is live. */
export function parseStatusPort(stdout: string): number | undefined {
    try {
        const parsed = JSON.parse(stdout) as { success?: unknown; data?: { enabled?: unknown; port?: unknown } | null };
        if (parsed.success !== true) return undefined;
        const data = parsed.data;
        if (data === null || typeof data !== 'object' || data.enabled !== true) return undefined;
        const port = data.port;
        return typeof port === 'number' && Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
    } catch {
        return undefined;
    }
}

/** The stream's tabs message: muxr only wants the current page address. */
export function parseStreamPage(raw: unknown): { url: string } | undefined {
    if (typeof raw !== 'string') return undefined;
    try {
        const message = JSON.parse(raw) as { type?: string; tabs?: { active?: boolean; url?: string }[] };
        if (message.type !== 'tabs' || !Array.isArray(message.tabs)) return undefined;
        const active = message.tabs.find((tab) => tab.active) ?? message.tabs[0];
        if (typeof active?.url !== 'string') return undefined;
        return { url: active.url };
    } catch {
        return undefined;
    }
}

/** Best-effort `code` for a printable character; the protocol dispatches on `key`. */
export function codeForKey(key: string): string {
    if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    if (key === 'Enter') return 'Enter';
    if (key === 'Backspace') return 'Backspace';
    if (key === ' ') return 'Space';
    return key;
}

export type ResolvedStreamPort =
    | { kind: 'ready'; port: number }
    | { kind: 'noBrowser'; detail: string | null }
    | { kind: 'unreachable' };

/** The slice of machineBash the stream resolution needs. */
type ShellResult = { success: boolean; stdout: string; stderr: string };

/**
 * The port the takeover watches: a fresh `stream enable`, or — when the daemon
 * reports one already bound (an orphaned viewer, a returned deep link) — the
 * bound port from `stream status`, so the screen reattaches to the live stream
 * instead of dead-ending on the enable error. A machine with neither keeps the
 * plain no-browser failure.
 */
export async function resolveStreamPort(
    run: (command: string) => Promise<ShellResult>,
    agentBrowser: string,
    requestedPort?: number,
): Promise<ResolvedStreamPort> {
    const enabled = await run(requestedPort === undefined ? `${agentBrowser} stream enable --json` : `${agentBrowser} stream enable --port ${requestedPort}`);
    if (enabled.success) {
        if (requestedPort !== undefined) return { kind: 'ready', port: requestedPort };
        const port = parseEnablePort(enabled.stdout);
        if (port !== undefined) return { kind: 'ready', port };
        return { kind: 'unreachable' };
    }
    // The daemon refuses a second enable while a stream is already bound;
    // that browser is perfectly streamable, so reattach to its bound port.
    const output = [enabled.stderr, enabled.stdout].filter(Boolean).join('\n');
    if (!/already enabled/i.test(output)) return { kind: 'noBrowser', detail: output || null };
    const status = await run(`${agentBrowser} stream status --json`);
    const bound = status.success ? parseStatusPort(status.stdout) : undefined;
    if (bound !== undefined) return { kind: 'ready', port: bound };
    return { kind: 'noBrowser', detail: output || null };
}

export interface OpenTakeover {
    wsUrl: string;
    close: () => void;
}

export type OpenTakeoverCommand = { port: number };

export async function openTakeover(command: OpenTakeoverCommand): Promise<OpenTakeover> {
    const tunnel = await attachPreviewTunnel(command.port);
    // Always ws: the tunnel carries raw TCP with no TLS in front of it.
    return {
        wsUrl: `ws://${tunnel.hostname}:${tunnel.port}/`,
        close: tunnel.close,
    };
}
