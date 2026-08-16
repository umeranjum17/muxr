import * as React from 'react';
import { AppState, Platform } from 'react-native';
import type { AgentLifecycle } from '@muxr/contract';
import { useAuth } from '@/auth/AuthContext';
import { useHerdrTree, useLocalSettingMutable, useSessions, useSocketStatus } from '@/sync/storage';
import {
    canPostPromotedNotifications,
    clearVoiceNotification,
    openPromotedNotificationSettings,
    startHerdKeepalive,
    stopHerdKeepalive,
    supportsPromotedNotifications,
    updateVoiceNotification,
} from '@/../modules/voice-overlay';
import { requestNotificationPermission } from '@/utils/microphonePermissions';
import { completionAlerts, completionNotificationState, herdNotificationState, sortHerd } from '@/utils/herd';
import { lifecycleTree } from '@/utils/herdTree';
import { boundRealtimeSession, useRealtimeMuted, useRealtimeSessionState } from '@/realtime/realtimeSessionState';
import { Modal } from '@/modal';

/**
 * Unconditional kernel owner for Android's foreground service and baseline
 * notification. Plugin enable/disable can change wording policy later, but it
 * must never own the service that keeps realtime microphone capture legal.
 */
export function KernelNotifications() {
    const sessions = useSessions();
    const { workspaces } = useHerdrTree();
    const { status } = useSocketStatus();
    const { isAuthenticated } = useAuth();
    const { state: voiceState } = useRealtimeSessionState();
    const muted = useRealtimeMuted();
    const panes = React.useMemo(() => sortHerd(sessions, lifecycleTree(workspaces, status === 'connected')), [sessions, status, workspaces]);
    const herd = React.useMemo(() => herdNotificationState(panes, status), [panes, status]);
    const voiceName = panes.find((pane) => pane.id === boundRealtimeSession())?.name ?? '';
    const previous = React.useRef<Record<string, AgentLifecycle> | null>(null);
    const [presentation, setPresentation] = React.useState(herd);
    const [appActive, setAppActive] = React.useState(AppState.currentState === 'active');
    const [promotionPrompted, setPromotionPrompted] = useLocalSettingMutable('promotedNotificationsPrompted');
    const promotionPrompting = React.useRef(false);
    const keepalive = React.useRef(false);
    const herdActive = herd.mode === 'working' || herd.mode === 'attention';

    React.useEffect(() => {
        const next = Object.fromEntries(panes.map((pane) => [pane.id, pane.status]));
        const before = previous.current;
        previous.current = next;
        if (before === null) return setPresentation(herd);
        const completed = completionAlerts(panes, before);
        setPresentation(completed.length ? completionNotificationState(completed) : herd);
    }, [herd, panes]);

    React.useEffect(() => {
        if (!isAuthenticated) {
            if (keepalive.current) stopHerdKeepalive();
            keepalive.current = false;
            clearVoiceNotification();
            return;
        }
        // Native stops its dataSync service once the herd settles. Mirror that
        // here so the next working transition actually starts it again.
        if (!herdActive) keepalive.current = false;
        let live = true;
        void requestNotificationPermission(false).then(() => {
            if (!live) return;
            updateVoiceNotification(herdActive ? herd : presentation, voiceState, voiceName, muted);
            if (herdActive && !keepalive.current) keepalive.current = startHerdKeepalive();
        });
        return () => { live = false; };
    }, [herd, herdActive, isAuthenticated, muted, presentation, voiceName, voiceState]);

    React.useEffect(() => {
        if (!isAuthenticated) return;
        setAppActive(AppState.currentState === 'active');
        const subscription = AppState.addEventListener('change', (state) => {
            const active = state === 'active';
            setAppActive(active);
            if (active && herdActive) keepalive.current = startHerdKeepalive();
        });
        return () => subscription.remove();
    }, [herdActive, isAuthenticated]);

    React.useEffect(() => {
        if (
            Platform.OS !== 'android'
            || !appActive
            || !isAuthenticated
            || !herdActive
            || promotionPrompted
            || promotionPrompting.current
            || !supportsPromotedNotifications()
            || canPostPromotedNotifications()
        ) return;
        promotionPrompting.current = true;
        setPromotionPrompted(true);
        void Modal.confirm(
            'Show live agent updates?',
            'Allow muxr Live Updates so working agents appear in Android’s status-bar island as well as notifications.',
            { confirmText: 'Open settings' },
        ).then((confirmed) => {
            if (confirmed) openPromotedNotificationSettings();
        }).finally(() => { promotionPrompting.current = false; });
    }, [appActive, herdActive, isAuthenticated, promotionPrompted, setPromotionPrompted]);

    return null;
}
