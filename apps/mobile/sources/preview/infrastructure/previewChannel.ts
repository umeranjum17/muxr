/**
 * Sealed preview frames over an open relay socket, page half.
 *
 * One relay socket carries one consumer: the socket joins a `bridge=1`
 * channel the relay blind-copies, and every payload is sealed with the
 * per-preview key the host already holds from `preview.attach`. An
 * authentication failure is reported as a peer close and answered with one,
 * mirroring the native bridge -- the relay only ever sees ids and flags.
 */

import { deriveV2Key, openPreviewPayload, sealPreviewPayload } from '@muxr/crypto';
import {
    decodePreviewFrame,
    encodePreviewFrame,
    PREVIEW_CLOSE,
    PREVIEW_DATA,
} from '@muxr/contract';

export interface PreviewChannelFrame {
    connId: number;
    closed: boolean;
    payload: Uint8Array;
}

export interface PreviewChannel {
    send: (connId: number, closed: boolean, payload?: Uint8Array) => void;
    onFrame: (handler: (frame: PreviewChannelFrame) => void) => void;
    close: () => void;
}

const EMPTY = new Uint8Array(0);

export function createPreviewChannel(socket: WebSocket, key: string): PreviewChannel {
    const clientToHostKey = deriveV2Key(key, 'client->host');
    const hostToClientKey = deriveV2Key(key, 'host->client');
    let handler: ((frame: PreviewChannelFrame) => void) | undefined;

    const rawSend = (bytes: Uint8Array): void => {
        if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
    };
    const send: PreviewChannel['send'] = (connId, closed, payload) => {
        if (closed) {
            rawSend(encodePreviewFrame(connId, PREVIEW_CLOSE));
            return;
        }
        if (payload === undefined || payload.length === 0) return;
        rawSend(encodePreviewFrame(connId, PREVIEW_DATA, sealPreviewPayload(payload, clientToHostKey)));
    };

    socket.binaryType = 'arraybuffer';
    socket.onmessage = (event) => {
        if (typeof event.data === 'string' || handler === undefined) return;
        const frame = decodePreviewFrame(new Uint8Array(event.data as ArrayBuffer));
        if (frame === undefined || (frame.flag !== PREVIEW_DATA && frame.flag !== PREVIEW_CLOSE)) return;
        if (frame.flag === PREVIEW_CLOSE || frame.payload.length === 0) {
            if (frame.flag === PREVIEW_CLOSE) handler({ connId: frame.connId, closed: true, payload: EMPTY });
            return;
        }
        try {
            handler({ connId: frame.connId, closed: false, payload: openPreviewPayload(frame.payload, hostToClientKey) });
        } catch {
            send(frame.connId, true);
            handler({ connId: frame.connId, closed: true, payload: EMPTY });
        }
    };

    return {
        send,
        onFrame: (next) => { handler = next; },
        close: () => {
            handler = undefined;
            if (socket.readyState === WebSocket.OPEN) socket.close();
        },
    };
}
