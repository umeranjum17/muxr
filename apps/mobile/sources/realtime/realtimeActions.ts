import {
    requestMicrophonePermission,
    requestNotificationPermission,
    showMicrophonePermissionDeniedAlert,
} from '@/utils/microphonePermissions';
import { Modal } from '@/modal';
import { takeLegacyRealtimeApiKey } from '@/sync/persistence';
import {
    openRealtimeConversation,
    realtimeSessionSnapshot,
    startRealtimeSession,
    type RealtimeTarget,
} from './realtimeSessionState';
import { voiceDiagnostic } from '@/voice/voiceDiagnostics';
import { callPlugin } from '@/plugins/callPlugin';
import { registerNativePushNotifications } from '@/utils/nativePushNotifications';
import { sync } from '@/sync/sync';

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

/**
 * The selected realtime provider plugin owns its credential on the machine.
 * It is provisioned through the authenticated E2EE channel, silently
 * transferring any leftover phone copy captured at load. New credentials are
 * collected only by the attributed plugin Settings secure prompt. False means
 * realtime cannot run.
 */
export async function ensureRealtimeProviderConfigured(): Promise<boolean> {
    const legacy = takeLegacyRealtimeApiKey();
    let configured: boolean;
    try {
        configured = ((await callPlugin('voice.status')) as { configured: boolean }).configured;
    } catch (error) {
        Modal.alert('Realtime conversation', `Could not reach the provider plugin: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    if (configured) return true;

    if (legacy == null || legacy.trim() === '') {
        Modal.alert('Realtime conversation', 'Configure the provider plugin from Settings to continue.');
        return false;
    }
    try {
        await callPlugin('voice.key.set', { key: legacy.trim() });
        return true;
    } catch (error) {
        Modal.alert('Realtime conversation', `The provider plugin rejected the migrated value: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

export async function confirmRealtimeProviderDataSharing(): Promise<boolean> {
    let providerName: string;
    try {
        const providers = await sync.request('voice.provider.list', {});
        const selected = providers.find((provider) => provider.selected);
        if (selected === undefined) {
            Modal.alert('Realtime conversation', 'Select a realtime voice provider in Settings to continue.');
            return false;
        }
        providerName = selected.name;
    } catch (error) {
        Modal.alert('Realtime conversation', `Could not identify the selected provider: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }

    return Modal.confirm(
        `Share voice data with ${providerName}?`,
        `Realtime voice sends microphone audio, system instructions, tool definitions, requested tool arguments, and tool output to ${providerName}. That provider's billing, retention, and privacy terms apply.`,
        { cancelText: 'Not Now', confirmText: 'Continue' },
    );
}

/** Start the singleton realtime session and reveal its root-owned sheet. */
export function beginRealtimeConversation(target: RealtimeTarget): boolean {
    startRealtimeSession(target);
    if (realtimeSessionSnapshot().state === 'disconnected') return false;
    openRealtimeConversation();
    return true;
}

export async function prepareRealtimeConversation(): Promise<boolean> {
    if (!(await ensureRealtimeProviderConfigured())) return false;
    if (!(await confirmRealtimeProviderDataSharing())) return false;
    return requestRealtimePermission();
}

export async function startRealtimeWithPermission(target: RealtimeTarget): Promise<boolean> {
    if (!(await prepareRealtimeConversation())) return false;
    return beginRealtimeConversation(target);
}
