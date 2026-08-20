/** A browser tab cannot bind a listener, so web keeps the relay-side port. */

export interface PreviewBridge {
    port: number;
    close: () => void;
}

export const previewBridgeAvailable = false;

export function startPreviewBridge(_socket: WebSocket): Promise<PreviewBridge> {
    return Promise.reject(new Error('Browser preview needs the muxr app on this platform.'));
}
