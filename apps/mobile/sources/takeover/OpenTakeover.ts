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
    return JSON.stringify({ type: 'input_keyboard', eventType, key, code });
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
    const match = /ws:\/\/127\.0\.0\.1:(\d{1,5})/.exec(text);
    if (match === null) return undefined;
    const port = Number(match[1]);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
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
