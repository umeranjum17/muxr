/**
 * Browser preview, device half.
 *
 * The relay opens the TCP listener; this only asks for one and holds the control
 * socket open, because the listener lives exactly as long as that socket. The
 * preview URL is built from the relay host the app is already connected to, so a
 * preview reaches as far as the session does -- LAN, Tailscale, a tunnel -- with
 * nothing extra to configure.
 */

import { issueWsTicket, newPreviewChannel, previewSocketUrl, ticketSocketUrl } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { sync } from '@/sync/sync';

const READY_TIMEOUT_MS = 15_000;

export interface OpenPreview {
    url: string;
    close: () => void;
}

/** Regex, not `new URL`: React Native's URL is partial and this is one field. */
function relayHostname(relayUrl: string): string | undefined {
    return /^wss?:\/\/([^/:?#]+)/i.exec(relayUrl)?.[1];
}

export async function openPreview(port: number): Promise<OpenPreview> {
    const settings = getCachedConnectionSettings();
    if (settings.mode !== 'local') throw new Error('Hosted Preview is disabled until browser trust and pinning are complete.');
    const hostname = relayHostname(settings.relayUrl);
    if (hostname === undefined) {
        throw new Error(`Cannot read a host from the relay URL "${settings.relayUrl}".`);
    }

    const channel = newPreviewChannel();
    // The host has to be on the channel before the relay will open a listener.
    await sync.request('preview.attach', { channel, port });

    const socketUrl = settings.token === '' || settings.token.startsWith('acctok_')
        ? previewSocketUrl(settings.relayUrl, {
            machineId: settings.machineId,
            channel,
            role: 'client',
            ...(settings.token === '' ? {} : { token: settings.token }),
        })
        : ticketSocketUrl(settings.relayUrl, await issueWsTicket({
            relayUrl: settings.relayUrl,
            credential: settings.token,
            machineId: settings.machineId,
            role: 'client',
            transport: 'preview',
            channel,
        }), 'preview');
    const socket = new WebSocket(socketUrl);

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
    return {
        url: `http://${hostname}:${previewPort}/`,
        close: () => socket.close(),
    };
}
