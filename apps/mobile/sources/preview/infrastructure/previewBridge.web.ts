/** Web cannot bind the native listener, so it keeps the relay-side port. */

export interface PreviewBridge {
    port: number;
    close: () => void;
}

export const previewBridgeAvailable = false;

export function startPreviewBridge(_socket: WebSocket, _key: string): Promise<PreviewBridge> {
    return Promise.reject(new Error('Native preview bridge unavailable on this platform.'));
}
