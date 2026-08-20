/**
 * Browser preview, device half.
 *
 * The device binds the listener and the relay only forwards frames, so the page
 * loads from the phone's own loopback over whatever transport the session
 * already uses -- LAN, Tailscale, a tunnel, a hosted relay. Asking the relay for
 * an ephemeral port instead only works where the relay is published beyond 443,
 * and is plain HTTP across the internet where it is, so web -- which cannot bind
 * a listener -- is the only caller left on that path.
 */

import { newPreviewKey } from '@muxr/crypto';
import { issueWsTicket, newPreviewChannel, previewSocketUrl, ticketSocketUrl } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { sync } from '@/sync/sync';
import { previewBridgeAvailable, startPreviewBridge } from './previewBridge';

const READY_TIMEOUT_MS = 15_000;

export interface OpenPreview {
    url: string;
    close: () => void;
}

export interface PreviewTunnel {
    hostname: string;
    port: number;
    close: () => void;
}

/** Regex, not `new URL`: React Native's URL is partial and this is one field. */
function relayHostname(relayUrl: string): string | undefined {
    return /^wss?:\/\/([^/:?#]+)/i.exec(relayUrl)?.[1];
}

function waitForRelay(socket: WebSocket, type: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('The relay did not pair the preview in time.'));
        }, READY_TIMEOUT_MS);
        socket.onmessage = (event) => {
            try {
                if ((JSON.parse(String(event.data)) as { type?: string }).type !== type) return;
            } catch { return; }
            clearTimeout(timer);
            resolve();
        };
        socket.onclose = () => { clearTimeout(timer); reject(new Error('The relay closed the preview before it was ready.')); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach the relay to open a preview.')); };
    });
}

/**
 * Join a preview channel to a loopback port and hold it open. The relay
 * listener carries raw TCP without parsing it, so anything that speaks over a
 * socket -- HTTP for previews, a WebSocket for the takeover stream -- can
 * ride the same tunnel.
 */
export async function attachPreviewTunnel(port: number): Promise<PreviewTunnel> {
    const settings = getCachedConnectionSettings();
    if (!previewBridgeAvailable && settings.mode !== 'local') {
        throw new Error('Browser preview needs the muxr app on this platform.');
    }
    const hostname = relayHostname(settings.relayUrl);
    if (hostname === undefined) {
        throw new Error(`Cannot read a host from the relay URL "${settings.relayUrl}".`);
    }

    const channel = newPreviewChannel();
    const key = previewBridgeAvailable ? newPreviewKey() : undefined;
    // The per-preview key crosses inside the existing E2EE request. The relay
    // sees connection ids for multiplexing, never the frontend bytes.
    await sync.request('preview.attach', { channel, port, ...(key === undefined ? {} : { key }) });

    const socketUrl = settings.token === '' || settings.token.startsWith('acctok_')
        ? previewSocketUrl(settings.relayUrl, {
            machineId: settings.machineId,
            channel,
            role: 'client',
            ...(settings.token === '' ? {} : { token: settings.token }),
            ...(previewBridgeAvailable ? { bridge: true } : {}),
        })
        : ticketSocketUrl(settings.relayUrl, await issueWsTicket({
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
            reject(new Error('The relay did not open a preview port in time.'));
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
            reject(new Error('The relay closed the preview before it was ready.'));
        };
        socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error('Could not reach the relay to open a preview.'));
        };
    });

    // Always http: the preview port carries raw TCP with no TLS in front of it.
    return { hostname, port: previewPort, close: () => socket.close() };
}

export async function openPreview(port: number): Promise<OpenPreview> {
    const tunnel = await attachPreviewTunnel(port);
    return {
        url: `http://${tunnel.hostname}:${tunnel.port}/`,
        close: tunnel.close,
    };
}
