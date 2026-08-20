import { stripTrailingSlashes } from './controlPlaneUrl.js';

/**
 * Browser preview: the wire format for tunnelling a dev server to the device.
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
    options: { machineId: string; channel: string; role: 'machine' | 'client'; token?: string; bridge?: boolean },
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
    // A bridging client holds its own listener, so the relay must not open one:
    // an ephemeral relay port is unreachable behind a tunnel that only proxies
    // 443, and it would be plain HTTP across the internet if it were.
    if (options.bridge === true) parts.push('bridge=1');
    return `${base}/preview?${parts.join('&')}`;
}
