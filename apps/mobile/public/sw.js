/*
 * muxr web push service worker.
 *
 * The page can't read localStorage here, so after subscribing it hands us
 * {controlUrl, token} via postMessage. We keep them in a module variable
 * (best-effort, in-memory only) and use them to answer push actions.
 */

let auth = null; // { controlUrl, token }

self.addEventListener('message', (event) => {
    const data = event.data;
    if (data && typeof data === 'object' && typeof data.controlUrl === 'string' && typeof data.token === 'string') {
        auth = data;
    }
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }
    const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'muxr';
    const body = typeof payload.body === 'string' ? payload.body : '';
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            data: payload,
            actions: [
                { action: 'approve', title: 'Approve' },
                { action: 'deny', title: 'Deny' },
            ],
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const payload = event.notification.data || {};
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const targetUrl = typeof payload.url === 'string' && payload.url.startsWith('/')
        ? payload.url
        : sessionId !== ''
            ? `/session/${encodeURIComponent(sessionId)}`
            : '/';
    const answer = event.action === 'approve' ? 'y' : event.action === 'deny' ? 'n' : null;

    event.waitUntil((async () => {
        // Action buttons answer the relay before opening the session; the
        // default click (or a click without stored auth) just opens it.
        if (answer !== null && sessionId !== '' && auth) {
            try {
                await fetch(`${auth.controlUrl}/v1/push/action`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${auth.token}`,
                    },
                    body: JSON.stringify({ sessionId, answer }),
                });
            } catch {
                // best-effort: the session still opens below
            }
        }
        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientsList) {
            if ('navigate' in client) {
                try {
                    await client.navigate(targetUrl);
                } catch {
                    continue; // can't navigate this client, try to open fresh
                }
                return client.focus();
            }
        }
        return self.clients.openWindow(targetUrl);
    })());
});
