/**
 * Preview tunnel: the wire format for tunnelling a takeover stream to the device.
 *
 * The device binds a local TCP listener and the host dials the dev server on its
 * own loopback. Native endpoints encrypt each payload before the relay forwards
 * it; the relay reads only the connection id and flag needed to multiplex TCP.
 * Nothing on the path parses HTTP, so WebSockets, SSE, and streams survive.
 *
 * A browser opens several TCP connections per page, so frames are multiplexed
 * over one socket and tagged with a connection id.
 *
 * Layout: connId (uint32 BE) | flag (uint8) | payload (opaque ciphertext on native E2EE)
 */

export const PREVIEW_DATA = 0;
/** Peer closed its end of this connection. Payload is empty. */
export const PREVIEW_CLOSE = 1;

export const PREVIEW_HEADER_BYTES = 5;

export interface PreviewFrame {
    connId: number;
    flag: number;
    payload: Uint8Array;
}

export function encodePreviewFrame(connId: number, flag: number, payload?: Uint8Array): Uint8Array {
    const body = payload ?? new Uint8Array(0);
    const frame = new Uint8Array(PREVIEW_HEADER_BYTES + body.length);
    new DataView(frame.buffer).setUint32(0, connId);
    frame[4] = flag;
    frame.set(body, PREVIEW_HEADER_BYTES);
    return frame;
}

export function decodePreviewFrame(raw: Uint8Array): PreviewFrame | undefined {
    if (raw.length < PREVIEW_HEADER_BYTES) return undefined;
    const connId = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0);
    return { connId, flag: raw[4] as number, payload: raw.subarray(PREVIEW_HEADER_BYTES) };
}
