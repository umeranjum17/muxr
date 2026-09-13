/*
 * muxr preview service worker.
 *
 * A browser tab cannot bind a loopback listener, so the previewed app reaches
 * the tab through the encrypted preview channel instead: this worker serves
 * same-origin URLs under /muxr-preview/<channel>/ by asking the owning page
 * (which holds the relay socket and the per-preview key) over a
 * BroadcastChannel and answering with exactly the bytes it returns.
 *
 * Deliberately thin: no sockets, no keys, no crypto here. Anything outside
 * the scope falls through to the network untouched. Requests the page cannot
 * answer fail closed with 502 after a timeout.
 */

const SCOPE = '/muxr-preview/';
const ROUND_TRIP_TIMEOUT_MS = 25_000;
const STRIPPED_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'proxy-authenticate']);
// Isolation is a property of the response, not of the button that opened it.
// Every document this worker serves is sandboxed without allow-same-origin,
// so a previewed app runs in an opaque origin whichever way it was reached:
// it never sees this origin's storage, cookies, service workers or opener.
// Popups stay inside the sandbox (no allow-popups-to-escape-sandbox), and a
// top-level navigation is refused outright below.
const DOCUMENT_SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';
const OVERRIDDEN_RESPONSE_HEADERS = new Set(['content-security-policy', 'content-security-policy-report-only', 'set-cookie', 'clear-site-data', 'service-worker-allowed']);

let nextId = 0;
const waiting = new Map();

const channel = new BroadcastChannel('muxr-preview');
channel.onmessage = (event) => {
    const message = event.data;
    if (message === null || typeof message !== 'object' || message.kind !== 'muxr-preview-response') return;
    const entry = waiting.get(message.id);
    if (entry === undefined) return;
    waiting.delete(message.id);
    entry(message);
};

function roundTrip(payload) {
    return new Promise((resolve) => {
        nextId += 1;
        const id = nextId;
        const timer = setTimeout(() => {
            waiting.delete(id);
            resolve(undefined);
        }, ROUND_TRIP_TIMEOUT_MS);
        waiting.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
        });
        channel.postMessage({ ...payload, kind: 'muxr-preview-request', id });
    });
}

async function handle(request, url) {
    // A top-level document would be a first-class page on the PWA origin.
    // Only frames may navigate here; the owning page embeds them.
    if (request.mode === 'navigate' && request.destination !== 'iframe' && request.destination !== 'frame') {
        return new Response('This preview only opens inside muxr. Go back to the muxr tab and use Preview there.', {
            status: 403,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': 'sandbox', 'cache-control': 'no-store' },
        });
    }
    const rest = url.pathname.slice(SCOPE.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return new Response('No preview channel.', { status: 404 });
    const previewChannel = rest.slice(0, slash);
    const target = rest.slice(slash) + url.search;
    const headers = [];
    request.headers.forEach((value, name) => {
        if (!STRIPPED_HEADERS.has(name.toLowerCase())) headers.push([name, value]);
    });
    let body;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        body = new Uint8Array(await request.arrayBuffer());
    }
    const answer = await roundTrip({
        channel: previewChannel,
        method: request.method,
        target,
        headers,
        body,
    });
    if (answer === undefined || answer.status === undefined) {
        return new Response('The preview stopped answering.', { status: 502 });
    }
    const out = new Headers();
    for (const [name, value] of answer.headers ?? []) {
        // The app's session cookies stay on the host loopback: never stored
        // here, and the app cannot loosen or replace the sandbox below.
        if (OVERRIDDEN_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
        try { out.append(name, value); } catch { /* a bad app header must not break the page */ }
    }
    if (request.mode === 'navigate') {
        out.set('content-security-policy', DOCUMENT_SANDBOX);
        out.set('cache-control', 'no-store');
    }
    return new Response(answer.body ?? new Uint8Array(0), { status: answer.status, headers: out });
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.startsWith(SCOPE)) return;
    event.respondWith(handle(event.request, url));
});
