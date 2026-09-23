/*
 * muxr web push service worker.
 *
 * Notification taps deep-link to the right session. The worker deliberately
 * never holds the device credential: the Open button opens the request
 * in the app, where the approval runs under the real device grant. A
 * reusable worker-side credential that could answer sessions (inject y/n)
 * is never issued — synthetic answers are also rejected outright when E2EE
 * is on (HTTP 410).
 */

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }
    const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'muxr';
    const body = typeof payload.body === 'string' ? payload.body : '';
    event.waitUntil((async () => {
        const response = await (await caches.open('muxr-push-level')).match('/muxr-push-level');
        const level = response ? await response.text() : 'off';
        if ((level !== 'important' && level !== 'all') || (payload.kind !== 'blocked' && payload.kind !== 'failed' && !(level === 'all' && payload.kind === 'done'))) return;
        await self.registration.showNotification(title, {
            body,
            data: payload,
            // The action deep-links to the blocked request; the approval
            // itself happens in the app under the device grant.
            actions: [
                { action: 'open', title: 'Open' },
            ],
        });
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const payload = event.notification.data || {};
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    let targetUrl = '/';
    if (typeof payload.url === 'string' && payload.url.startsWith('/')) targetUrl = payload.url;
    else if (sessionId !== '') targetUrl = `/session/${encodeURIComponent(sessionId)}`;

    event.waitUntil((async () => {
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
