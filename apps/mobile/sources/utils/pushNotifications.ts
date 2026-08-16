import { Platform } from 'react-native';
import { relayControlUrl } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/state/connectionSettings';

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed';

const SW_PATH = '/sw.js';

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

// Mirrors the SW's subscription so the settings row has a cheap sync read.
let lastKnownSubscribed = false;

/** Sync snapshot for the settings row; refresh with refreshPushState() for accuracy. */
export function getPushState(): PushState {
    if (!isWebPushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return lastKnownSubscribed ? 'subscribed' : 'unsubscribed';
}

/** Async re-check against the push manager (covers subscriptions made on earlier visits). */
export async function refreshPushState(): Promise<PushState> {
    if (!isWebPushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try {
        const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        lastKnownSubscribed = sub !== null;
    } catch {
        lastKnownSubscribed = false;
    }
    return lastKnownSubscribed ? 'subscribed' : 'unsubscribed';
}

/**
 * Full subscribe flow: permission → register sw.js → fetch the VAPID public
 * key from the relay → subscribe the push manager → POST the subscription →
 * hand the SW {relayUrl, token} so it can answer actions.
 */
export async function requestPermissionAndSubscribe(): Promise<boolean> {
    if (!isWebPushSupported()) return false;
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            lastKnownSubscribed = false;
            return false;
        }

        const settings = getCachedConnectionSettings();
        if (settings.token === '') return false;
        const base = relayControlUrl(settings.relayUrl);

        const reg = await navigator.serviceWorker.register(SW_PATH);
        await navigator.serviceWorker.ready;

        const vapidRes = await fetch(`${base}/v1/push/vapid-public`, {
            headers: { Authorization: `Bearer ${settings.token}` },
        });
        if (!vapidRes.ok) return false;
        const { publicKey } = await vapidRes.json() as { publicKey: string };

        let subscription = await reg.pushManager.getSubscription();
        if (!subscription) {
            subscription = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
        }

        const subRes = await fetch(`${base}/v1/push/subscribe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${settings.token}`,
            },
            body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
        if (!subRes.ok) return false;

        // Best-effort: the SW needs these to answer action buttons. If there
        // is no controller yet (first load), it catches up on the next visit.
        const controller = navigator.serviceWorker.controller;
        if (controller) {
            controller.postMessage({ controlUrl: base, token: settings.token });
        }
        lastKnownSubscribed = true;
        return true;
    } catch (error) {
        console.warn('[push] subscribe failed', error);
        return false;
    }
}
