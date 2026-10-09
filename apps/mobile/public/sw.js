importScripts('/pushNotice.bundle.js');

// Offline app shell. The version below is rewritten to the export's shell hash
// by finalizeWebExport, so a new web build installs a new worker, precaches the
// new shell under a new cache name, and deletes the old caches on activate.
// Only the static shell is ever cached: relay, link and API traffic is not.
const SHELL_CACHE_PREFIX = 'muxr-shell-';
const SHELL_VERSION = '__MUXR_SHELL_VERSION__';
const SHELL_CACHE = SHELL_CACHE_PREFIX + SHELL_VERSION;
const SHELL_URL = '/index.html';
const SHELL_ASSET_PREFIXES = ['/_expo/', '/assets/'];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        await precacheShell(await caches.open(SHELL_CACHE));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE)
            .map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    let url;
    try {
        url = new URL(request.url);
    } catch {
        return;
    }
    // A different origin is relay, link or third-party traffic: never cached.
    if (url.origin !== self.location.origin) return;
    if (request.mode === 'navigate') {
        event.respondWith(navigationResponse(request));
        return;
    }
    if (isShellAsset(url.pathname)) {
        event.respondWith(shellAsset(request));
    }
});

function isShellAsset(pathname) {
    return SHELL_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Cache the served app shell and the immutable assets it references, so a reload
// with no network boots the app instead of a browser error page.
async function precacheShell(cache) {
    const response = await fetch(SHELL_URL, { cache: 'no-store' });
    if (!response || !response.ok) throw new Error('muxr shell fetch failed');
    const html = await response.clone().text();
    await cache.put(SHELL_URL, response);
    await Promise.all(referencedShellAssets(html).map(async (assetUrl) => {
        try {
            const asset = await fetch(assetUrl, { cache: 'no-store' });
            if (asset && asset.ok) await cache.put(assetUrl, asset);
        } catch {
            // One missing asset must not abort the whole shell install.
        }
    }));
}

function referencedShellAssets(html) {
    const found = new Set();
    const pattern = /(?:src|href)="([^"]+)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
        const value = match[1];
        if (!value.startsWith('/') || value.startsWith('//') || !isShellAsset(value)) continue;
        found.add(value);
    }
    return [...found];
}

async function navigationResponse(request) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        // The online document is served as-is; the versioned cache is owned by
        // install/activate alone, so a build staged by the host can never leave
        // a cached index.html pointing at assets this cache does not hold.
        return await fetch(request);
    } catch (error) {
        const cached = await cache.match(SHELL_URL);
        if (cached) return cached;
        throw error;
    }
}

async function shellAsset(request) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
    }
    return response;
}

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
        const sessionId = typeof notice.data.sessionId === 'string' ? notice.data.sessionId : '';
        await self.registration.showNotification(notice.title, {
            body: notice.body,
            data: notice.data,
            // One alert per agent: a newer question replaces the one it asked before.
            ...(sessionId === '' ? {} : { tag: `agent:${sessionId}`, renotify: true }),
            // The action deep-links to the blocked question; a browser
            // notification cannot carry a typed reply, so it is answered there.
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
        // Fragments stay in the browser: the relay must not receive decrypted scope.
        targetUrl = `/notification#machineId=${encodeURIComponent(machineId)}&sessionId=${encodeURIComponent(sessionId)}`;
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
