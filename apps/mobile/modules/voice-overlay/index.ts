import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

type VoiceState = 'disconnected' | 'connecting' | 'connected' | 'thinking' | 'speaking';
type HerdMode = 'connecting' | 'offline' | 'idle' | 'working' | 'attention' | 'finished';
type NotificationAction = 'start' | 'stop' | 'mute';

interface VoiceNative {
    routeVoiceAudio: () => boolean;
    releaseVoiceAudio: () => boolean;
    startRealtimePcm?: (sampleRate: number) => boolean;
    playRealtimePcm?: (base64: string) => boolean;
    clearRealtimePcm?: () => boolean;
    stopRealtimePcm?: () => void;
    startService: () => boolean;
    stopService: () => boolean;
    startHerdService: () => boolean;
    stopHerdService: () => boolean;
    updateNotification: (
        mode: HerdMode,
        count: number,
        names: string,
        eventKey: string,
        voiceState: VoiceState,
        voiceName: string,
        muted: boolean,
    ) => boolean;
    supportsPromotedNotifications?: () => boolean;
    canPostPromotedNotifications?: () => boolean;
    openPromotedNotificationSettings?: () => boolean;
    openBackgroundActivitySettings?: () => boolean;
    clearNotification: () => boolean;
    addListener: (
        event: 'onNotificationActionRequested',
        listener: (payload: { action: NotificationAction }) => void,
    ) => { remove: () => void };
}

const native =
    Platform.OS === 'web' ? null : requireOptionalNativeModule<VoiceNative>('VoiceOverlay');

/** Start before capture; Android rejects a late microphone FGS start. */
export function startVoiceService(): boolean {
    // iOS/web have no Android microphone service; the realtime path remains
    // valid there. Android reports launch failures instead of throwing across
    // the JS event callback.
    if (native === null) return true;
    try {
        return native.startService();
    } catch {
        return false;
    }
}

export function stopVoiceService(): void {
    try {
        native?.stopService();
    } catch {
        // Teardown must remain best-effort even if Android is already stopping.
    }
}

/**
 * Keeps a dataSync foreground service alive while authenticated so Android
 * never freezes the process: the herd socket survives in the background and
 * the Live Update keeps tracking working agents. Start only while the app is
 * in the foreground (background FGS starts are rejected since Android 12).
 */
export function startHerdKeepalive(): boolean {
    if (native === null) return true;
    try {
        return native.startHerdService();
    } catch {
        return false;
    }
}

export function stopHerdKeepalive(): void {
    try {
        native?.stopHerdService();
    } catch {
        // Same best-effort rule as voice teardown.
    }
}

/** Headset if the user is wearing one, speaker otherwise. */
export function routeVoiceAudio(): boolean {
    return native?.routeVoiceAudio() ?? false;
}

export function releaseVoiceAudio(): void {
    native?.releaseVoiceAudio();
}

export function startRealtimePcm(sampleRate: number): boolean {
    return native?.startRealtimePcm?.(sampleRate) ?? false;
}

export function playRealtimePcm(base64: string): boolean {
    return native?.playRealtimePcm?.(base64) ?? false;
}

export function clearRealtimePcm(): void {
    native?.clearRealtimePcm?.();
}

export function stopRealtimePcm(): void {
    native?.stopRealtimePcm?.();
}

export function updateVoiceNotification(
    herd: { mode: HerdMode; count: number; name: string; names: string; eventKey: string },
    voiceState: VoiceState,
    voiceName: string,
    muted = false,
): boolean {
    return native?.updateNotification(
        herd.mode,
        herd.count,
        herd.names,
        herd.eventKey,
        voiceState,
        voiceName,
        muted,
    ) ?? false;
}

export function supportsPromotedNotifications(): boolean {
    try {
        return native?.supportsPromotedNotifications?.() ?? false;
    } catch {
        return false;
    }
}

export function canPostPromotedNotifications(): boolean {
    try {
        return native?.canPostPromotedNotifications?.() ?? true;
    } catch {
        return true;
    }
}

export function openPromotedNotificationSettings(): boolean {
    try {
        return native?.openPromotedNotificationSettings?.() ?? false;
    } catch {
        return false;
    }
}

export function openBackgroundActivitySettings(): boolean {
    try {
        return native?.openBackgroundActivitySettings?.() ?? false;
    } catch {
        return false;
    }
}

export function clearVoiceNotification(): void {
    native?.clearNotification();
}

export function addVoiceNotificationActionListener(
    listener: (action: NotificationAction) => void,
): { remove: () => void } | null {
    return native?.addListener('onNotificationActionRequested', ({ action }) => listener(action)) ?? null;
}
