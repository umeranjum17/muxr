import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { AudioModule } from 'expo-audio';
import { getCachedConnectionSettings } from '@/connection';
import { voiceStatus } from '../application/voiceSettings';
import {
    preconnectRealtimeSession,
    realtimeSessionSnapshot,
    resolveRealtimeTarget,
    type RealtimeTarget,
} from '../application/realtimeSessionState';

/** The call a talk here would open, when it can connect without asking for anything. */
async function preconnectTarget(sessionId: string | undefined): Promise<RealtimeTarget | null> {
    const snapshot = realtimeSessionSnapshot();
    if (snapshot.state !== 'disconnected' || snapshot.starting) return null;
    try {
        if (!(await AudioModule.getRecordingPermissionsAsync()).granted) return null;
        const status = await voiceStatus();
        // Codex Voice is the WebRTC provider, the one path that connects with
        // no microphone. A PCM provider needs capture to connect at all.
        if (!status.configured || status.providerId !== 'codex') return null;
        const explicit = sessionId?.trim();
        return explicit
            ? { machineId: getCachedConnectionSettings().machineId, sessionId: explicit }
            : await resolveRealtimeTarget();
    } catch {
        return null;
    }
}

/**
 * While a screen with a talk control is in front, keep the call that control
 * would open already connected, so a talk skips the provider's setup. It is
 * dropped when the screen loses focus or the app leaves the foreground.
 *
 * Android only, where a warm call is checked to hold no microphone and leave
 * the device's audio mode alone. On iOS, WebRTC sets up its own audio session
 * once remote audio starts; whether that lights the microphone indicator or
 * stops other audio has not been checked.
 */
export function useRealtimePreconnect(sessionId?: string, enabled = true): void {
    const focused = useIsFocused();
    const [appActive, setAppActive] = React.useState(AppState.currentState === 'active');
    React.useEffect(() => AppState.addEventListener('change', (next) => setAppActive(next === 'active')).remove, []);
    const active = enabled && focused && appActive && Platform.OS === 'android';
    React.useEffect(() => {
        if (!active) return;
        let cancelled = false;
        let release = () => {};
        void preconnectTarget(sessionId).then((target) => {
            if (!cancelled && target !== null) release = preconnectRealtimeSession(target);
        });
        return () => {
            cancelled = true;
            release();
        };
    }, [active, sessionId]);
}
