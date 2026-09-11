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

import { attachPreviewTunnel, previewBridgeAvailable } from '@/preview';
import type { Point, StreamFrameMetadata } from '../domain/coordinates';
import { createTakeoverWs } from '../infrastructure/takeoverWs';

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
                offsetTop: typeof metadata.offsetTop === 'number' ? metadata.offsetTop : 0,
                scrollOffsetX: typeof metadata.scrollOffsetX === 'number' ? metadata.scrollOffsetX : 0,
                scrollOffsetY: typeof metadata.scrollOffsetY === 'number' ? metadata.scrollOffsetY : 0,
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

/** A wheel tick at a page point; the page decides whether it scrolls. */
export function wheelMessage(point: Point, deltaX: number, deltaY: number): string {
    return JSON.stringify({
        type: 'input_mouse',
        eventType: 'mouseWheel',
        x: point.x,
        y: point.y,
        button: 'none',
        clickCount: 0,
        deltaX: Math.round(deltaX),
        deltaY: Math.round(deltaY),
    });
}

/**
 * Chromium performs an editing key's action (delete, submit, move) only when
 * the dispatched event carries its virtual key code; `key`/`code` alone is a
 * dead keypress. Printable characters act through `text` instead.
 */
const VIRTUAL_KEY_CODES: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
};

export function keyMessage(eventType: 'keyDown' | 'keyUp', key: string, code: string): string {
    const printable = key.length === 1 && key >= ' ' && key !== '\x7f';
    const virtualKeyCode = VIRTUAL_KEY_CODES[key];
    return JSON.stringify({
        type: 'input_keyboard',
        eventType,
        key,
        code,
        ...(eventType === 'keyDown' && printable ? { text: key } : {}),
        ...(virtualKeyCode === undefined ? {} : { windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }),
    });
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
    /** Raw-TCP path only; absent when `stream` carries the session. */
    wsUrl?: string;
    close: () => void;
    /**
     * WebSocket-over-multiplex stream for browsers, which cannot bind the
     * loopback listener the raw path needs. Same agent-browser protocol,
     * same input messages -- only the transport differs.
     */
    stream?: TakeoverStream;
}

export interface TakeoverStream {
    send: (message: string) => void;
    onMessage: (handler: (data: string) => void) => void;
    onClose: (handler: () => void) => void;
    close: () => void;
}

export type OpenTakeoverCommand = { port: number; mode?: 'observe' | 'control' };

/** The host rejects a second controller while one holds the stream. */
export function isTakeoverConflict(error: unknown): boolean {
    return error instanceof Error && error.message.includes('controlled by another device');
}

export async function openTakeover(command: OpenTakeoverCommand): Promise<OpenTakeover> {
    const mode = command.mode ?? 'control';
    // Native always takes the raw-TCP tunnel with a real loopback listener.
    // A browser with a service-worker-capable secure context instead drives
    // the agent-browser WebSocket over sealed preview frames; anywhere else
    // the legacy relay-side port keeps working through a plain WebSocket.
    if (typeof window !== 'undefined' && previewBridgeAvailable) {
        const tunnel = await attachPreviewTunnel(command.port, { wsStream: true, mode });
        if (tunnel.wsChannel === undefined) throw new Error('The takeover stream is unavailable in this browser.');
        const ws = createTakeoverWs(tunnel.wsChannel);
        try {
            await ws.connect();
        } catch (error) {
            // A failed upgrade must not leave the tunnel open and unreferenced:
            // the relay would hold the pair and the host the port forever.
            tunnel.close();
            throw error;
        }
        let messageHandler: ((data: string) => void) | undefined;
        let closeHandler: (() => void) | undefined;
        ws.onText((text) => messageHandler?.(text));
        ws.onClose(() => closeHandler?.());
        return {
            close: () => {
                ws.close();
                tunnel.close();
            },
            stream: {
                send: (message) => ws.sendText(message),
                onMessage: (handler) => { messageHandler = handler; },
                onClose: (handler) => { closeHandler = handler; },
                close: () => ws.close(),
            },
        };
    }
    const tunnel = await attachPreviewTunnel(command.port, { rawTcp: true, mode });
    // Always ws: the tunnel carries raw TCP with no TLS in front of it.
    return {
        wsUrl: `ws://${tunnel.hostname}:${tunnel.port}/`,
        close: tunnel.close,
    };
}
