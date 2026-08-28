import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { relayControlUrl } from '@muxr/contract';
import { TokenStorage, type AuthCredentials } from '@/account';
import { getCachedConnectionSettings } from '@/connection';
import { clearRegisteredPushToken, loadRegisteredPushToken, saveRegisteredPushToken } from '@/catalog/application/persistence';
import { requestNotificationPermission } from '@/utils/microphonePermissions';
import { storage } from '@/catalog/store';

let registering: Promise<boolean> | null = null;

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

/** Register this iPhone with the relay after the user has granted notifications. */
export function registerNativePushNotifications(): Promise<boolean> {
    if (Platform.OS !== 'ios') return Promise.resolve(false);
    if (registering !== null) return registering;
    registering = (async () => {
        if (!(await requestNotificationPermission(false))) return false;
        const credentials = await TokenStorage.getCredentials();
        if (credentials === null) return false;
        const projectId = Constants.easConfig?.projectId
            ?? (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
        if (projectId === undefined) return false;
        const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
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
        const response = await fetch(`${relay}/v1/push/expo-subscribe`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${credentials.token}`,
            },
            body: JSON.stringify({ token }),
        });
        if (!response.ok) return false;
        saveRegisteredPushToken(token);
        return true;
    })().catch((error) => {
        console.warn('[push] native registration failed', error);
        return false;
    }).finally(() => { registering = null; });
    return registering;
}

/** Remove this device before its credential is cleared or revoked. */
export async function unregisterNativePushNotifications(credentials: AuthCredentials): Promise<void> {
    if (Platform.OS !== 'ios') return;
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
}
