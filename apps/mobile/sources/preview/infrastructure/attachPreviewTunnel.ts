/**
 * Raw TCP tunnel used by graphical takeover.
 *
 * The device binds the listener and the relay only forwards frames, so a
 * takeover stream can use the same transport as the session. The relay sees
 * connection ids for multiplexing, never the frontend bytes.
 */

import { newPreviewKey } from '@muxr/crypto';
import { issueWsTicket, newPreviewChannel, ticketSocketUrl } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';

const READY_TIMEOUT_MS = 15_000;

export interface PreviewTunnel {
    hostname: string;
    port: number;
    close: () => void;
}

/** Regex, not `new URL`: React Native's URL is partial and this is one field. */
function relayHostname(relayUrl: string): string | undefined {
    return /^wss?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(relayUrl)?.[1]?.toLowerCase();
}

function waitForRelay(socket: WebSocket, type: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('The preview tunnel did not pair in time.'));
        }, READY_TIMEOUT_MS);
        socket.onmessage = (event) => {
            try {
                if ((JSON.parse(String(event.data)) as { type?: string }).type !== type) return;
            } catch { return; }
            clearTimeout(timer);
            resolve();
        };
        socket.onclose = () => { clearTimeout(timer); reject(new Error('The preview tunnel closed before it was ready.')); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach the relay for the preview tunnel.')); };
    });
}

/** Join a preview channel to a loopback port and hold it open for takeover. */
export async function attachPreviewTunnel(port: number): Promise<PreviewTunnel> {
    const { previewBridgeAvailable, startPreviewBridge } = await import('./previewBridge');
    const settings = getCachedConnectionSettings();
    if (!previewBridgeAvailable && settings.mode !== 'local') {
        throw new Error('A native preview bridge is unavailable on this platform.');
    }
    const hostname = relayHostname(settings.relayUrl);
    if (hostname === undefined) {
        throw new Error(`Cannot read a host from the relay URL "${settings.relayUrl}".`);
    }

    const channel = newPreviewChannel();
    const key = previewBridgeAvailable ? newPreviewKey() : undefined;
    await sync.request('preview.attach', { channel, port, ...(key === undefined ? {} : { key }) });

    if (settings.token === '' || settings.token.startsWith('acctok_')) {
        throw new Error('preview: relay ticket required');
    }
    const socketUrl = ticketSocketUrl(settings.relayUrl, await issueWsTicket({
        relayUrl: settings.relayUrl,
        credential: settings.token,
        machineId: settings.machineId,
        role: 'client',
        transport: 'preview',
        channel,
    }), 'preview', previewBridgeAvailable);
    const socket = new WebSocket(socketUrl);

    if (previewBridgeAvailable) {
        socket.binaryType = 'arraybuffer';
        await waitForRelay(socket, 'preview.bridge');
        if (key === undefined) throw new Error('Encrypted preview key unavailable.');
        const bridge = await startPreviewBridge(socket, key);
        return { hostname: '127.0.0.1', port: bridge.port, close: bridge.close };
    }

    const previewPort = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('The preview tunnel did not open a port in time.'));
        }, READY_TIMEOUT_MS);

        socket.onmessage = (event) => {
            try {
                const message = JSON.parse(String(event.data)) as { type?: string; port?: number };
                if (message.type !== 'preview.ready' || typeof message.port !== 'number') return;
                clearTimeout(timer);
                resolve(message.port);
            } catch {
                /* not the frame we are waiting for */
            }
        };
        socket.onclose = () => {
            clearTimeout(timer);
            reject(new Error('The preview tunnel closed before it was ready.'));
        };
        socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error('Could not reach the relay for the preview tunnel.'));
        };
    });

    return { hostname, port: previewPort, close: () => socket.close() };
}
