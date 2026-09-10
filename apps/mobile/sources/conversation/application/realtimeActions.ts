import {
    requestMicrophonePermission,
    requestNotificationPermission,
    showMicrophonePermissionDeniedAlert,
} from '@/utils/microphonePermissions';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import {
    openRealtimeConversation,
    realtimeSessionSnapshot,
    startRealtimeSession,
    type RealtimeTarget,
} from './realtimeSessionState';
import { voiceDiagnostic } from '../infrastructure/voiceDiagnostics';
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

/** Realtime calls need the mic foreground service and background audio, which
 * browsers cannot provide — and asking for the microphone first would imply
 * the call can work. Say so up front; terminal, files, diffs, pairing, and
 * notifications all work in this browser. */
export function alertRealtimeWebUnsupported(): void {
    Modal.alert(
        'Realtime voice needs the native app',
        'Voice calls stay on Android and iOS, where the microphone foreground service keeps them alive with the screen off. Everything else works here.',
    );
}

export async function startRealtimeWithPermission(target: RealtimeTarget): Promise<boolean> {
    if (Platform.OS === 'web') {
        alertRealtimeWebUnsupported();
        return false;
    }
    if (!(await requestRealtimePermission())) return false;
    if (!(await ensureRealtimeProviderConfigured())) return false;
    return beginRealtimeConversation(target);
}
