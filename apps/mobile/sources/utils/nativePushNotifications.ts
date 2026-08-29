import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { relayControlUrl, type LifecycleNotificationLevel } from '@muxr/contract';
import { TokenStorage, type AuthCredentials } from '@/account';
import { getCachedConnectionSettings } from '@/connection';
import { clearRegisteredPushToken, loadRegisteredPushToken, saveRegisteredPushToken } from '@/catalog/application/persistence';
import { requestNotificationPermission } from '@/utils/microphonePermissions';
import { storage } from '@/catalog/store';

let registering: Promise<boolean> | null = null;
let pendingNotificationLevel: LifecycleNotificationLevel | null = null;
let syncingNotificationLevel: Promise<boolean> | null = null;
let notificationRegistrationGeneration = 0;
let unregistering: Promise<void> | null = null;

/** Claim relay-owned lifecycle alerts before catalog reconciliation can repost them. */
export function acknowledgeLifecyclePush(data: unknown): boolean {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
    const payload = data as Record<string, unknown>;
    const eventId = payload.eventId;
    const machineId = payload.machineId;
    if (payload.presentationOwner !== 'relay-push') return false;
    if (typeof eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(eventId)) return false;
    if (typeof machineId !== 'string' || machineId.length > 128 || machineId.trim() !== machineId || /[\u0000-\u001f\u007f]/.test(machineId)) return false;
    if (machineId === '') return false;
    storage.getState().acknowledgeLifecyclePush(eventId, machineId);
    return true;
}

async function subscribeNativePush(
    token: string,
    credentials: AuthCredentials,
    level: LifecycleNotificationLevel,
): Promise<boolean> {
    const response = await fetch(`${relayControlUrl(getCachedConnectionSettings().relayUrl)}/v1/push/expo-subscribe`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${credentials.token}`,
        },
        body: JSON.stringify({ token, level }),
    });
    return response.ok;
}

function drainNotificationLevel(): Promise<boolean> {
    if (syncingNotificationLevel !== null) {
        return syncingNotificationLevel.then(() =>
            pendingNotificationLevel === null ? true : drainNotificationLevel());
    }
    if (pendingNotificationLevel === null) return Promise.resolve(true);
    const generation = notificationRegistrationGeneration;
    const sync = (async () => {
        let synced = false;
        while (pendingNotificationLevel !== null && generation === notificationRegistrationGeneration) {
            const level = pendingNotificationLevel;
            pendingNotificationLevel = null;
            const token = loadRegisteredPushToken();
            const credentials = await TokenStorage.getCredentials();
            if (token === null || credentials === null) {
                synced = false;
                continue;
            }
            try {
                synced = await subscribeNativePush(token, credentials, level);
            } catch {
                synced = false;
            }
        }
        return synced;
    })();
    const syncing = sync.finally(() => {
        if (syncingNotificationLevel === syncing) syncingNotificationLevel = null;
    });
    syncingNotificationLevel = syncing;
    return syncing.then((synced) =>
        pendingNotificationLevel === null ? synced : drainNotificationLevel());
}

/** Coalesce rapid changes and serialize writes so relay arrival order cannot restore a stale level. */
export function updateNativePushNotificationLevel(level: LifecycleNotificationLevel): Promise<boolean> {
    if (Platform.OS !== 'ios') return Promise.resolve(false);
    if (unregistering !== null) return unregistering.then(() => false);
    pendingNotificationLevel = level;
    return registering === null
        ? drainNotificationLevel()
        : registering.then(() => drainNotificationLevel());
}

/** Register this iPhone with the relay after the user has granted notifications. */
export function registerNativePushNotifications(): Promise<boolean> {
    if (unregistering !== null) return unregistering.then(() => registerNativePushNotifications());
    if (Platform.OS !== 'ios') return Promise.resolve(false);
    if (registering !== null) return registering;
    registering = (async () => {
        const generation = notificationRegistrationGeneration;
        if (!(await requestNotificationPermission(false))) return false;
        const credentials = await TokenStorage.getCredentials();
        if (credentials === null) return false;
        const projectId = Constants.easConfig?.projectId
            ?? (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
        if (projectId === undefined) return false;
        const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
        if (notificationRegistrationGeneration !== generation) return false;
        const relay = relayControlUrl(getCachedConnectionSettings().relayUrl);
        const previous = loadRegisteredPushToken();
        if (previous !== null && previous !== token) {
            await fetch(`${relay}/v1/push/expo-subscribe`, {
                method: 'DELETE',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${credentials.token}`,
                },
                body: JSON.stringify({ token: previous }),
            }).catch(() => undefined);
        }
        if (syncingNotificationLevel !== null) await syncingNotificationLevel;
        const level = storage.getState().localSettings.lifecycleNotificationLevel;
        if (!(await subscribeNativePush(token, credentials, level))) return false;
        saveRegisteredPushToken(token);
        return await drainNotificationLevel();
    })().catch((error) => {
        console.warn('[push] native registration failed', error);
        return false;
    }).finally(() => { registering = null; });
    return registering;
}

/** Remove this device before its credential is cleared or revoked. */
export function unregisterNativePushNotifications(credentials: AuthCredentials): Promise<void> {
    if (Platform.OS !== 'ios') return Promise.resolve();
    if (unregistering !== null) return unregistering;
    notificationRegistrationGeneration += 1;
    pendingNotificationLevel = null;
    unregistering = (async () => {
        if (registering !== null) await registering;
        pendingNotificationLevel = null;
        if (syncingNotificationLevel !== null) await syncingNotificationLevel;
        pendingNotificationLevel = null;
        const token = loadRegisteredPushToken();
        if (token === null) return;
        const relay = relayControlUrl(getCachedConnectionSettings().relayUrl);
        try {
            const response = await fetch(`${relay}/v1/push/expo-subscribe`, {
                method: 'DELETE',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${credentials.token}`,
                },
                body: JSON.stringify({ token }),
            });
            if (response.ok || response.status === 401 || response.status === 403 || response.status === 404) {
                clearRegisteredPushToken();
            }
        } catch {}
    })().finally(() => { unregistering = null; });
    return unregistering;
}
