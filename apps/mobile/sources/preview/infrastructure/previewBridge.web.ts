/**
 * Browser preview, page half.
 *
 * A tab cannot bind the loopback listener the native bridge uses, so the page
 * drives the same E2EE channel with HTTP request bytes instead (see
 * previewHttpBridge) and serves the app to an iframe from a same-origin
 * service-worker scope. The relay still blind-copies sealed frames, the host
 * still dials only the attached loopback port, and `preview.attach` still
 * requires a control grant -- view-only browsers cannot open this.
 *
 * Available only where a service worker can run (secure context). Anywhere
 * else the caller keeps the legacy relay-side port path.
 */

import { createPreviewHttpBridge } from './previewHttpBridge';
import type { PreviewBridge } from './previewBridge';

export const previewBridgeAvailable =
    typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && window.isSecureContext === true;

const SW_URL = '/muxr-preview-sw.js';
const SW_SCOPE = '/muxr-preview/';
const SW_START_TIMEOUT_MS = 10_000;

async function ensureWorkerActive(registration: ServiceWorkerRegistration): Promise<void> {
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (worker === null) throw new Error('Preview service worker did not install.');
    if (worker.state === 'activated') return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Preview service worker did not start.')), SW_START_TIMEOUT_MS);
        worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') {
                clearTimeout(timer);
                resolve();
            } else if (worker.state === 'redundant') {
                clearTimeout(timer);
                reject(new Error('Preview service worker did not start.'));
            }
        });
    });
}

export async function startPreviewBridge(socket: WebSocket, key: string, channel: string): Promise<PreviewBridge> {
    if (!previewBridgeAvailable) {
        throw new Error('Browser preview needs a secure context with a service worker.');
    }
    const bridge = createPreviewHttpBridge({
        key,
        sendBinary: (bytes) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
        },
    });
    socket.onmessage = (event) => {
        if (typeof event.data !== 'string') bridge.handleSocketBytes(new Uint8Array(event.data as ArrayBuffer));
    };
    socket.onclose = () => bridge.close();

    // getRegistration matches by scope prefix, so a root push worker would
    // shadow this scope forever and the bridge would silently serve the app
    // shell. Match the exact scope instead.
    const scopeUrl = new URL(SW_SCOPE, window.location.origin).href;
    const registrations = await navigator.serviceWorker.getRegistrations();
    const registration =
        registrations.find((entry) => entry.scope === scopeUrl)
        ?? (await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }));
    await ensureWorkerActive(registration);

    // The worker owns the scope; the page owns the socket. Requests arrive
    // here addressed by channel so stray tabs never answer each other.
    const bus = new BroadcastChannel('muxr-preview');
    bus.onmessage = (event) => {
        const message = event.data as {
            kind?: string;
            id?: number;
            channel?: string;
            method?: string;
            target?: string;
            headers?: Array<[string, string]>;
            body?: Uint8Array;
        } | null;
        if (message === null || message.kind !== 'muxr-preview-request' || message.channel !== channel) return;
        void bridge
            .request(message.target ?? '/', {
                method: message.method ?? 'GET',
                headers: message.headers ?? [],
                body: message.body,
            })
            .then(
                (response) => bus.postMessage({
                    kind: 'muxr-preview-response',
                    id: message.id,
                    status: response.status,
                    headers: response.headers,
                    body: response.body,
                }),
                () => bus.postMessage({ kind: 'muxr-preview-response', id: message.id }),
            );
    };

    const close = (): void => {
        bus.close();
        bridge.close();
        if (socket.readyState === WebSocket.OPEN) socket.close();
    };
    return { port: 0, url: `${window.location.origin}/muxr-preview/${channel}/`, close };
}
