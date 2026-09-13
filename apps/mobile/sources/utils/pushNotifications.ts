import { Platform } from 'react-native';
import { relayControlUrl } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';
import { getCachedHostedGrant } from '@/pairing/e2ee';
import { storage } from '@/catalog/store';

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
 * tell the SW the control URL (never a credential: notification taps
 * deep-link into the session, where approval runs under the real grant).
 *
 * The credential is the paired device credential from the stored hosted
 * grant — the same one transport uses. settings.token is permanently empty
 * on web and must not gate this flow.
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
        const grant = settings.mode === 'hosted' ? getCachedHostedGrant(settings.machineId) : undefined;
        const credential = grant?.credential ?? settings.token;
        if (credential === '') return false;
        const base = relayControlUrl(settings.relayUrl);

        const reg = await navigator.serviceWorker.register(SW_PATH);
        await navigator.serviceWorker.ready;

        const vapidRes = await fetch(`${base}/v1/push/vapid-public`, {
            headers: { Authorization: `Bearer ${credential}` },
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

        const level = storage.getState().localSettings.lifecycleNotificationLevel;
        const subRes = await fetch(`${base}/v1/push/subscribe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify({ subscription: subscription.toJSON(), level }),
        });
        if (!subRes.ok) return false;

        // Best-effort: the SW only needs the control URL so taps can
        // deep-link to the right session. It never receives the device
        // credential, so a compromised worker cannot answer approvals.
        const controller = navigator.serviceWorker.controller;
        if (controller) {
            controller.postMessage({ controlUrl: base });
        }
        lastKnownSubscribed = true;
        return true;
    } catch (error) {
        console.warn('[push] subscribe failed', error);
        return false;
    }
}

/** Remove this browser's push subscription (logout, revoke, re-pair). */
export async function unsubscribeWebPush(): Promise<void> {
    if (!isWebPushSupported()) return;
    try {
        const settings = getCachedConnectionSettings();
        const grant = settings.mode === 'hosted' ? getCachedHostedGrant(settings.machineId) : undefined;
        const credential = grant?.credential ?? settings.token;
        const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
        const subscription = reg ? await reg.pushManager.getSubscription() : null;
        if (credential !== '') {
            await fetch(`${relayControlUrl(settings.relayUrl)}/v1/push/subscribe`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${credential}` },
            }).catch(() => undefined);
        }
        await subscription?.unsubscribe().catch(() => undefined);
    } catch {
        // best-effort: revocation already closed the sockets server-side
    } finally {
        lastKnownSubscribed = false;
    }
}
