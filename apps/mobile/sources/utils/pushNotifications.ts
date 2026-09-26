import { Platform } from 'react-native';
import type { LifecycleNotificationLevel } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';
import { activeSessionClient } from '@/connection/sessionClientRef';
import { storage } from '@/catalog/store';

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed' | 'unregistered' | 'unknown';

const SW_PATH = '/sw.js';
const LEVEL_CACHE = 'muxr-push-level';
const CONFIRMED_PREFIX = 'muxr.webPush.confirmed.';
let lastKnownEndpoint: string | null = null;
let queryFailed = false;

function confirmed(machineId: string, endpoint: string): boolean {
    try {
        return localStorage.getItem(`${CONFIRMED_PREFIX}${machineId}`) === endpoint;
    } catch {
        return false;
    }
}

function recordConfirmation(machineId: string, endpoint: string): boolean {
    try {
        localStorage.setItem(`${CONFIRMED_PREFIX}${machineId}`, endpoint);
        return true;
    } catch {
        return false;
    }
}

let levelWrite = Promise.resolve();
let pendingLevel: LifecycleNotificationLevel | null = null;
let syncingLevel: Promise<boolean> | null = null;

export function storeWebPushNotificationLevel(level: LifecycleNotificationLevel): Promise<boolean> {
    if (!isWebPushSupported()) return Promise.resolve(true);
    if (typeof caches === 'undefined') return Promise.resolve(false);
    levelWrite = levelWrite.catch(() => {}).then(async () => {
        await (await caches.open(LEVEL_CACHE)).put('/muxr-push-level', new Response(level));
    });
    return levelWrite.then(() => true, () => false);
}

function isWebPushSupported(): boolean {
    return Platform.OS === 'web'
        && typeof navigator !== 'undefined'
        && 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window;
}

/** base64url (vapid public key) → Uint8Array for applicationServerKey. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = atob(raw);
    const out = new Uint8Array(new ArrayBuffer(bytes.length));
    for (let i = 0; i < bytes.length; i++) {
        out[i] = bytes.charCodeAt(i);
    }
    return out;
}

/** Sync snapshot for the settings row; refresh with refreshPushState() for accuracy. */
export function getPushState(): PushState {
    if (!isWebPushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (queryFailed) return 'unknown';
    if (lastKnownEndpoint === null) return 'unsubscribed';
    return confirmed(getCachedConnectionSettings().machineId, lastKnownEndpoint) ? 'subscribed' : 'unregistered';
}

/** Async re-check against the push manager (covers subscriptions made on earlier visits). */
export async function refreshPushState(): Promise<PushState> {
    if (!isWebPushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try {
        const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        lastKnownEndpoint = sub?.endpoint ?? null;
        queryFailed = false;
    } catch {
        queryFailed = true;
    }
    return getPushState();
}

/**
 * Full subscribe flow: permission → register sw.js → request the VAPID public
 * key on the link → subscribe the push manager → register on the link.
 * Notification taps deep-link into the session, where approval runs under
 * the real grant; the worker never holds a credential.
 *
 * The active session's link grant authorizes both the key and registration.
 */
export async function requestPermissionAndSubscribe(): Promise<boolean> {
    if (!isWebPushSupported()) return false;
    let subscription: PushSubscription | null = null;
    let created = false;
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            lastKnownEndpoint = null;
            return false;
        }

        const settings = getCachedConnectionSettings();
        const client = activeSessionClient();
        if (client === undefined || !client.isLive()) return false;

        const reg = await navigator.serviceWorker.register(SW_PATH);
        await navigator.serviceWorker.ready;

        const { publicKey } = await client.request('push.vapid', {});

        subscription = await reg.pushManager.getSubscription();
        if (!subscription) {
            subscription = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
            created = true;
        }

        const level = storage.getState().localSettings.lifecycleNotificationLevel;
        const web = subscription.toJSON();
        if (!web.endpoint || !web.keys?.p256dh || !web.keys.auth) return false;
        await client.request('push.subscribe', { subscription: { endpoint: web.endpoint, keys: { p256dh: web.keys.p256dh, auth: web.keys.auth } }, level });
        if (!await storeWebPushNotificationLevel(level) || !recordConfirmation(settings.machineId, subscription.endpoint)) {
            if (created) await subscription.unsubscribe().catch(() => undefined);
            lastKnownEndpoint = null;
            return false;
        }

        lastKnownEndpoint = subscription.endpoint;
        queryFailed = false;
        return true;
    } catch (error) {
        if (created) await subscription?.unsubscribe().catch(() => undefined);
        lastKnownEndpoint = null;
        console.warn('[push] subscribe failed', error);
        return false;
    }
}

/** Re-POST the existing browser subscription with a new level (opt-out sync). */
async function postWebPushNotificationLevel(level: LifecycleNotificationLevel): Promise<boolean> {
    if (!isWebPushSupported()) return false;
    try {
        const settings = getCachedConnectionSettings();
        const client = activeSessionClient();
        const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
        const subscription = reg ? await reg.pushManager.getSubscription() : null;
        const web = subscription?.toJSON();
        if (client === undefined || !client.isLive() || !subscription || !web?.endpoint || !web.keys?.p256dh || !web.keys.auth) return false;
        await client.request('push.subscribe', { subscription: { endpoint: web.endpoint, keys: { p256dh: web.keys.p256dh, auth: web.keys.auth } }, level });
        return recordConfirmation(settings.machineId, subscription.endpoint);
    } catch {
        return false;
    }
}

function drainWebPushNotificationLevel(): Promise<boolean> {
    if (syncingLevel !== null) {
        return syncingLevel.then((synced) =>
            pendingLevel === null ? synced : drainWebPushNotificationLevel());
    }
    if (pendingLevel === null) return Promise.resolve(true);
    const sync = (async () => {
        let synced = false;
        while (pendingLevel !== null) {
            const level = pendingLevel;
            pendingLevel = null;
            synced = await postWebPushNotificationLevel(level);
        }
        return synced;
    })();
    const syncing = sync.finally(() => {
        if (syncingLevel === syncing) syncingLevel = null;
    });
    syncingLevel = syncing;
    return syncing.then((synced) =>
        pendingLevel === null ? synced : drainWebPushNotificationLevel());
}

export function updateWebPushNotificationLevel(level: LifecycleNotificationLevel): Promise<boolean> {
    pendingLevel = level;
    return drainWebPushNotificationLevel();
}

/** Remove this browser's link registration before forgetting its grant. */
export async function unsubscribeWebPush(): Promise<void> {
    if (!isWebPushSupported()) return;
    if (syncingLevel !== null) await syncingLevel;
    pendingLevel = null;
    try {
        const client = activeSessionClient();
        if (client?.isLive()) await client.request('push.unsubscribe', {});
        const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
        await (reg ? await reg.pushManager.getSubscription() : null)?.unsubscribe().catch(() => undefined);
    } catch {
        // best-effort: revocation already closed the sockets server-side
    } finally {
        try { localStorage.removeItem(`${CONFIRMED_PREFIX}${getCachedConnectionSettings().machineId}`); } catch {}
        lastKnownEndpoint = null;
        queryFailed = false;
    }
}
