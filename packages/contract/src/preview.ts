import { stripTrailingSlashes } from './controlPlaneUrl.js';

/**
 * Browser preview: the wire format for tunnelling a dev server to the device.
 *
 * The device binds a local TCP listener and the host dials the dev server on its
 * own loopback; the bytes in between are forwarded verbatim. Nothing on the path
 * parses HTTP, which is why websockets, SSE and streaming responses survive it --
 * and why a dev server bound to 127.0.0.1 works without rebinding.
 *
 * A browser opens several TCP connections per page, so frames are multiplexed
 * over one socket and tagged with a connection id.
 *
 * Layout: connId (uint32 BE) | flag (uint8) | payload
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

/** An HTTP listener the host found on its own machine. */
export interface PreviewServer {
    port: number;
    /** Bind address as the OS reports it, e.g. `127.0.0.1` or `0.0.0.0`. */
    bind: string;
    /** Process name, e.g. `node`. Empty when the OS withheld it. */
    command: string;
    pid?: number;
}

/** Random channel id. The relay pairs the two sockets quoting the same one. */
export function newPreviewChannel(): string {
    return `pv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Both ends build the preview socket URL from the same relay URL they already
 * use, so a preview reaches exactly as far as the session link does -- LAN,
 * Tailscale, a tunnel, anything. There is no second address to configure.
 */
export function previewSocketUrl(
    relayUrl: string,
    options: { machineId: string; channel: string; role: 'machine' | 'client'; token?: string },
): string {
    // Hand-built rather than URLSearchParams: this runs on React Native too,
    // where that polyfill is partial.
    const base = stripTrailingSlashes(relayUrl);
    const parts = [
        `role=${options.role}`,
        `machineId=${encodeURIComponent(options.machineId)}`,
        `channel=${encodeURIComponent(options.channel)}`,
    ];
    if (options.token !== undefined && options.token !== '') {
        parts.push(`token=${encodeURIComponent(options.token)}`);
    }
    return `${base}/preview?${parts.join('&')}`;
}
