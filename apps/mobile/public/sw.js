importScripts('/pushNotice.bundle.js');

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }
    event.waitUntil((async () => {
        const notice = await self.openLifecyclePush(payload);
        let level = null;
        try {
            const response = await (await caches.open('muxr-push-level')).match('/muxr-push-level');
            level = response ? await response.text() : null;
        } catch {
            // An unreadable cache is an unknown preference, not an opt-out.
        }
        if (level === 'off' || (level === 'important' && notice.data.kind === 'done')) return;
        await self.registration.showNotification(notice.title, {
            body: notice.body,
            data: notice.data,
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
    const machineId = typeof payload.machineId === 'string' ? payload.machineId : '';
    if (machineId !== '' && sessionId !== '') {
        targetUrl = `/notification?machineId=${encodeURIComponent(machineId)}&sessionId=${encodeURIComponent(sessionId)}`;
    }

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
