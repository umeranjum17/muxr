import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { relayControlUrl } from '@muxr/contract';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { clearRegisteredPushToken, loadRegisteredPushToken, saveRegisteredPushToken } from '@/sync/persistence';
import { requestNotificationPermission } from '@/utils/microphonePermissions';

let registering: Promise<boolean> | null = null;

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
