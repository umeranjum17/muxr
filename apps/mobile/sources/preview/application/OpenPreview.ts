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
import { issueWsTicket, newPreviewChannel, ticketSocketUrl } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';
import { getCachedHostedGrant } from '@/pairing/e2ee';
import { sync } from '@/catalog/sync';
import type { PreviewChannel } from '../infrastructure/previewChannel';

const READY_TIMEOUT_MS = 15_000;

export interface OpenPreview {
    url: string;
    close: () => void;
}

export type OpenPreviewCommand = {
    port: number;
    onIosSimulator?: boolean;
};

export interface PreviewTunnel {
    hostname: string;
    port: number;
    close: () => void;
    /**
     * Loadable URL on web, where the bridge serves same-origin through a
     * service worker instead of a loopback listener. Absent for raw-TCP
     * tunnels (native bridge, relay-side port, takeover stream).
     */
    url?: string;
    /**
     * Raw sealed frame channel for consumers that speak their own protocol
     * over the tunnel (the takeover stream). Present only on the bridge path
     * when the caller asked for it; the HTTP preview bridge consumes its own
     * socket instead.
     */
    wsChannel?: PreviewChannel;
}

/** Regex, not `new URL`: React Native's URL is partial and this is one field. */
function relayHostname(relayUrl: string): string | undefined {
    return /^wss?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(relayUrl)?.[1]?.toLowerCase();
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
export async function attachPreviewTunnel(port: number, options?: { rawTcp?: boolean; wsStream?: boolean; mode?: 'observe' | 'control' }): Promise<PreviewTunnel> {
    const { previewBridgeAvailable, startPreviewBridge } = await import('../infrastructure/previewBridge');
    // The raw-TCP takeover stream needs the byte tunnel, never the web HTTP
    // bridge; the wsStream takeover variant speaks over sealed frames instead.
    const bridgeAvailable = options?.rawTcp === true ? false : previewBridgeAvailable;
    const settings = getCachedConnectionSettings();
    if (!bridgeAvailable && settings.mode !== 'local') {
        throw new Error(
            'Browser preview needs a secure context with service workers (https or localhost). '
            + 'Open this page over https, or use the Android/iOS app.',
        );
    }
    const hostname = relayHostname(settings.relayUrl);
    if (hostname === undefined) {
        throw new Error(`Cannot read a host from the relay URL "${settings.relayUrl}".`);
    }

    const channel = newPreviewChannel();
    const key = bridgeAvailable ? newPreviewKey() : undefined;
    // Hosted browser grants carry no settings.token (always ''), so resolve
    // the exact-machine device grant first — same shape as the terminal — and
    // fail before attach: a takeover attach registers the controller, and a
    // ticket failure after it would strand the port. Tickets live 60s; mint,
    // attach, and connect back-to-back.
    const grant = settings.mode === 'hosted' ? getCachedHostedGrant(settings.machineId) : undefined;
    if (settings.mode === 'hosted' && grant === undefined) {
        throw new Error('preview: hosted machine grant is missing; pair this browser again');
    }
    if (grant !== undefined && grant.expiresAt <= Date.now()) {
        throw new Error('preview: device grant expired; pair this browser again');
    }
    const ticketInput = grant !== undefined
        ? { relayUrl: grant.relayUrl, credential: grant.credential }
        : settings.token !== '' && !settings.token.startsWith('acctok_')
            ? { relayUrl: settings.relayUrl, credential: settings.token }
            : undefined;
    if (ticketInput === undefined) {
        throw new Error('preview: relay ticket required');
    }
    const ticket = await issueWsTicket({
        relayUrl: ticketInput.relayUrl,
        credential: ticketInput.credential,
        machineId: settings.machineId,
        role: 'client',
        transport: 'preview',
        channel,
    });
    // The per-preview key crosses inside the existing E2EE request. The relay
    // sees connection ids for multiplexing, never the frontend bytes.
    // Takeover callers claim a mode so the host arbitrates control.
    await sync.request('preview.attach', {
        channel,
        port,
        ...(key === undefined ? {} : { key }),
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
    });

    const socketUrl = ticketSocketUrl(ticketInput.relayUrl, ticket, 'preview', previewBridgeAvailable);
    const socket = new WebSocket(socketUrl);

    // A failure after this point must not leave the socket open and
    // unreferenced: the relay would hold the pair and, for takeover, the
    // host would hold the port forever.
    try {
        if (bridgeAvailable) {
            socket.binaryType = 'arraybuffer';
            await waitForRelay(socket, 'preview.bridge');
            if (key === undefined) throw new Error('Encrypted preview key unavailable.');
            if (options?.wsStream === true) {
                // The takeover stream speaks WebSocket itself over sealed frames;
                // hand over the socket untouched instead of starting the HTTP bridge.
                const { createPreviewChannel } = await import('../infrastructure/previewChannel');
                return { hostname: '', port: 0, close: () => socket.close(), wsChannel: createPreviewChannel(socket, key) };
            }
            const bridge = await startPreviewBridge(socket, key, channel);
            if (bridge.url !== undefined) {
                return { hostname: '', port: 0, url: bridge.url, close: bridge.close };
            }
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
    } catch (error) {
        try {
            socket.close();
        } catch {
            // The original failure already explains the outcome.
        }
        throw error;
    }
}

export async function openPreview(command: OpenPreviewCommand): Promise<OpenPreview> {
    const port = command.port;
    // The iOS simulator shares the Mac's loopback. Bypass the native TCP bridge
    // only for an explicit local-development connection to that same loopback:
    // a paired remote machine may expose the same port on a different host.
    if (command.onIosSimulator === true) {
        const settings = getCachedConnectionSettings();
        const hostname = relayHostname(settings.relayUrl);
        if (
            settings.mode === 'local'
            && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
        ) {
            return { url: `http://127.0.0.1:${port}/`, close: () => undefined };
        }
        throw new Error(
            'Preview from a remote machine is unavailable in the iOS Simulator. '
            + 'Use a physical device, or connect the simulator to a host running on this Mac through a loopback relay.',
        );
    }
    const tunnel = await attachPreviewTunnel(port);
    if (tunnel.url !== undefined) return { url: tunnel.url, close: tunnel.close };
    return {
        url: `http://${tunnel.hostname}:${tunnel.port}/`,
        close: tunnel.close,
    };
}
