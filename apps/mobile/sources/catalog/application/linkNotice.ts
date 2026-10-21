import { listPairedGrants } from '@/pairing/e2ee';
import { isSealedLifecyclePush, openLifecycleNotice } from '@/utils/openLifecycleNotice';
import { storage } from './storage';

/**
 * A general notification the host sent over the link because this device has
 * no push address (Android). Raised like a delivered push, so a tap opens its
 * link through the same seal check. Only 'all' asked for general notices; the
 * host cannot see this device's level.
 */
export async function receiveLinkNotice(payload: unknown): Promise<void> {
    if (storage.getState().localSettings.lifecycleNotificationLevel !== 'all' || !isSealedLifecyclePush(payload)) return;
    const notice = openLifecycleNotice(payload, await listPairedGrants());
    if (notice.data.kind !== 'notify') return;
    // Loaded here, like lifecycleAlert's own entry, so sync's importers stay free of expo-notifications.
    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
        // One row per id: a repeat replaces it, as the relay drops a repeated push.
        identifier: `notify:${String(notice.data.eventId)}`,
        content: { title: notice.title, body: notice.body, data: { ...notice.data, data: (payload as { data: unknown }).data, presented: true } },
        trigger: null,
    });
}
