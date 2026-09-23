import { Platform } from 'react-native';
import type { LifecycleNotificationLevel } from '@muxr/contract';
import type { PushState } from '@/utils/pushNotifications';

/** Which agent events alert, in the words a settings row shows beneath its title. */
export function notificationLevelSummary(level: LifecycleNotificationLevel): string {
    switch (level) {
        case 'off': return 'Off';
        case 'important': return 'When an agent needs you';
        case 'all': return 'When an agent needs you or finishes';
    }
}

/** A browser only alerts once it is subscribed, so its state comes first. */
export function browserNotificationSummary(state: PushState, level: LifecycleNotificationLevel): string {
    switch (state) {
        case 'subscribed': return notificationLevelSummary(level);
        case 'denied': return 'Blocked in this browser';
        case 'unsupported': return 'Not available in this browser';
        default: return 'Off';
    }
}

/** On a phone the system permission gates every alert, so it comes first. */
export function phoneNotificationSummary(allowed: boolean, level: LifecycleNotificationLevel): string {
    if (allowed) return notificationLevelSummary(level);
    return Platform.OS === 'ios' ? 'Off in iOS Settings' : 'Off in Android settings';
}
