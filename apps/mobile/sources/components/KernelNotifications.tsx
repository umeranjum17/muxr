import * as React from 'react';
import { AppState, Platform } from 'react-native';
import type { AgentLifecycle } from '@muxr/contract';
import { useAuth } from '@/auth/AuthContext';
import { useHerdrTree, useLifecycleCatalogAvailable, useLocalSetting, useLocalSettingMutable, useSessions, useSocketStatus } from '@/sync/storage';
import {
    canPostPromotedNotifications,
    clearVoiceNotification,
    openBackgroundActivitySettings,
    openPromotedNotificationSettings,
    startHerdKeepalive,
    stopHerdKeepalive,
    supportsPromotedNotifications,
    updateVoiceNotification,
} from '@/../modules/voice-overlay';
import { requestNotificationPermission } from '@/utils/microphonePermissions';
import { completionNotificationState, completionTransition, herdNotificationState, sortHerd } from '@/utils/herd';
import { lifecycleTree } from '@/utils/herdTree';
import { boundRealtimeSession, configureVadStandby, useRealtimeMuted, useRealtimeSessionState } from '@/realtime/realtimeSessionState';
import { Modal } from '@/modal';
import { registerNativePushNotifications } from '@/utils/nativePushNotifications';

/**
 * Unconditional kernel owner for Android's foreground service and baseline
 * notification. Plugin enable/disable can change wording policy later, but it
 * must never own the service that keeps realtime microphone capture legal.
 */
export function KernelNotifications() {
    const sessions = useSessions();
    const sessionCount = Object.keys(sessions).length;
    const { workspaces } = useHerdrTree();
    const { status } = useSocketStatus();
    const lifecycleCatalogAvailable = useLifecycleCatalogAvailable();
    const { isAuthenticated } = useAuth();
    const { state: voiceState } = useRealtimeSessionState();
    const muted = useRealtimeMuted();
    const panes = React.useMemo(() => sortHerd(sessions, lifecycleTree(workspaces, status === 'connected')), [sessions, status, workspaces]);
    const herd = React.useMemo(() => herdNotificationState(panes, status), [panes, status]);
    const nativeHerd = React.useMemo(
        () => lifecycleCatalogAvailable && herd.mode === 'attention' ? { ...herd, eventKey: 'attention:' } : herd,
        [herd, lifecycleCatalogAvailable],
    );
    const voiceName = panes.find((pane) => pane.id === boundRealtimeSession())?.name ?? '';
    const previous = React.useRef<Record<string, AgentLifecycle> | null>(null);
    const [presentation, setPresentation] = React.useState(herd);
    const [appActive, setAppActive] = React.useState(AppState.currentState === 'active');
    const [promotionPrompted, setPromotionPrompted] = useLocalSettingMutable('promotedNotificationsPrompted');
    const [backgroundPrompted, setBackgroundPrompted] = useLocalSettingMutable('backgroundConnectionPrompted');
    const vadStandbyEnabled = useLocalSetting('vadStandbyEnabled');
    const promotionPrompting = React.useRef(false);
    const backgroundPrompting = React.useRef(false);
    const keepalive = React.useRef(false);
    const herdActive = herd.mode === 'working' || herd.mode === 'attention';

    React.useEffect(() => {
        if (lifecycleCatalogAvailable) {
            previous.current = null;
            setPresentation(herd);
            return;
        }
        const before = previous.current;
        const { baseline, completed } = completionTransition(panes, status === 'connected', before);
        previous.current = baseline;
        if (before === null) return setPresentation(herd);
        setPresentation(completed.length ? completionNotificationState(completed) : herd);
    }, [herd, lifecycleCatalogAvailable, panes, status]);

    React.useEffect(() => {
        if (!isAuthenticated) {
            if (keepalive.current) stopHerdKeepalive();
            keepalive.current = false;
            clearVoiceNotification();
            return;
        }
        // A brief background network drop must not tear down the service that
        // keeps the socket alive long enough to reconnect. A connected idle
        // herd still stops it normally.
        if (!appActive && keepalive.current && status !== 'connected') return;
        // Native stops its dataSync service once the herd settles. Mirror that
        // here so the next working transition actually starts it again.
        if (!herdActive) keepalive.current = false;
        let live = true;
        void requestNotificationPermission(false).then(() => {
            if (!live) return;
            updateVoiceNotification(herdActive ? nativeHerd : presentation, voiceState, voiceName, muted);
            if (herdActive && !keepalive.current) keepalive.current = startHerdKeepalive();
        });
        return () => { live = false; };
    }, [appActive, herdActive, isAuthenticated, muted, nativeHerd, presentation, status, voiceName, voiceState]);

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
        if (Platform.OS === 'ios' && isAuthenticated && appActive) {
            void registerNativePushNotifications();
        }
    }, [appActive, isAuthenticated]);

    React.useEffect(() => {
        if (isAuthenticated && appActive && vadStandbyEnabled && sessionCount > 0) {
            void configureVadStandby(true);
        }
    }, [appActive, isAuthenticated, sessionCount, vadStandbyEnabled]);

    React.useEffect(() => {
        if (
            Platform.OS !== 'android'
            || !appActive
            || !isAuthenticated
            || !herdActive
            || backgroundPrompted
            || backgroundPrompting.current
        ) return;
        backgroundPrompting.current = true;
        setBackgroundPrompted(true);
        void Modal.confirm(
            'Keep muxr connected in the background?',
            'Android may pause muxr when you leave the app. Open app settings, choose Battery, then allow background activity or select Unrestricted. If your phone has “Manage automatically”, turn it off and allow background running.',
            { confirmText: 'Open settings' },
        ).then((confirmed) => {
            if (confirmed) openBackgroundActivitySettings();
        }).finally(() => { backgroundPrompting.current = false; });
    }, [appActive, backgroundPrompted, herdActive, isAuthenticated, setBackgroundPrompted]);

    React.useEffect(() => {
        if (
            Platform.OS !== 'android'
            || !appActive
            || !isAuthenticated
            || !herdActive
            || promotionPrompted
            || promotionPrompting.current
            || backgroundPrompting.current
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
