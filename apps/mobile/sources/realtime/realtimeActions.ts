import {
    requestMicrophonePermission,
    requestNotificationPermission,
    showMicrophonePermissionDeniedAlert,
} from '@/utils/microphonePermissions';
import { Modal } from '@/modal';
import {
    openRealtimeConversation,
    realtimeSessionSnapshot,
    startRealtimeSession,
    type RealtimeTarget,
} from './realtimeSessionState';
import { voiceDiagnostic } from '@/voice/voiceDiagnostics';
import { callPlugin } from '@/plugins/callPlugin';
import { registerNativePushNotifications } from '@/utils/nativePushNotifications';

export async function requestRealtimePermission(): Promise<boolean> {
    voiceDiagnostic('permission.begin');
    let permission;
    try {
        permission = await requestMicrophonePermission();
    } finally {
        voiceDiagnostic('permission.end');
    }
    if (!permission.granted) {
        showMicrophonePermissionDeniedAlert(permission.canAskAgain);
        return false;
    }
    // Realtime still works if the user declines, but Android otherwise hides the
    // foreground-service tray and promoted ongoing status chip completely.
    await requestNotificationPermission();
    void registerNativePushNotifications();
    return true;
}

/** The selected provider plugin owns its credential on the machine. */
export async function ensureRealtimeProviderConfigured(): Promise<boolean> {
    let configured: boolean;
    try {
        configured = ((await callPlugin('voice.status')) as { configured: boolean }).configured;
    } catch (error) {
        Modal.alert('Realtime conversation', `Could not reach the provider plugin: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    if (configured) return true;
    Modal.alert('Realtime conversation', 'Configure the provider plugin from Settings to continue.');
    return false;
}

/** Start the singleton realtime session and reveal its root-owned sheet. */
export function beginRealtimeConversation(target: RealtimeTarget): boolean {
    startRealtimeSession(target);
    if (realtimeSessionSnapshot().state === 'disconnected') return false;
    openRealtimeConversation();
    return true;
}

export async function startRealtimeWithPermission(target: RealtimeTarget): Promise<boolean> {
    if (!(await requestRealtimePermission())) return false;
    if (!(await ensureRealtimeProviderConfigured())) return false;
    return beginRealtimeConversation(target);
}
