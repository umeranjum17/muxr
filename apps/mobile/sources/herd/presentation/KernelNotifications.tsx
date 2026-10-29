import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { status as statusChip } from '@byokit/statusbar';
import { useRouter } from 'expo-router';
import { refreshStatusChip, statusChipAgentKey, statusChipVoiceKey } from '../application/refreshStatusChip';
import { navigateToSession } from '../application/useNavigateToSession';
import { startRealtimeCapability } from '@/conversation';
import type { AgentLifecycle } from '@trymuxr/contract';
import { useAuth } from '@/account/ui';
import { useHerdrTree, useLifecycleCatalogAvailable, useLocalSetting, useSessions, useSocketStatus } from '@/catalog/store';
import {
    clearVoiceNotification,
    startHerdKeepalive,
    stopHerdKeepalive,
    updateVoiceNotification,
} from '@/../modules/voice-overlay';
import { notificationPermissionStatus } from '@/utils/microphonePermissions';
import { completionNotificationState, completionTransition, herdNotificationState, herdPaneName, nativeLifecycleNotificationState, sortHerd, type HerdNotificationState } from '../domain/herd';
import { applyRealtimeMuted, boundRealtimeSession, realtimeGeneration, retryVadStandby, stopRealtimeSession, useRealtimeMuted, useRealtimeSessionState } from '@/conversation/session';
import { registerNativePushNotifications } from '@/utils/nativePushNotifications';
import { focusedAgentRoute, subscribeFocusedAgent } from '@/watch/lifecycleAlert';

function sameNotification(
    left: HerdNotificationState,
    right: HerdNotificationState,
): boolean {
    return left.mode === right.mode
        && left.count === right.count
        && left.name === right.name
        && left.names === right.names
        && left.eventKey === right.eventKey;
}


/**
 * Unconditional kernel owner for Android's foreground service and baseline
 * notification. Plugin enable/disable can change wording policy later, but it
 * must never own the service that keeps realtime microphone capture legal.
 */
export function KernelNotifications() {
    const router = useRouter();
    const [chipActions, setChipActions] = React.useState<string[]>([]);
    const sessions = useSessions();
    const sessionCount = Object.keys(sessions).length;
    const { workspaces } = useHerdrTree();
    const { status } = useSocketStatus();
    const lifecycleCatalogAvailable = useLifecycleCatalogAvailable();
    const { isAuthenticated } = useAuth();
    const { state: voiceState } = useRealtimeSessionState();
    const muted = useRealtimeMuted();
    const panes = React.useMemo(() => sortHerd(sessions, workspaces), [sessions, workspaces]);
    const focusedRoute = React.useSyncExternalStore(subscribeFocusedAgent, focusedAgentRoute, () => null);
    const herd = React.useMemo(() => herdNotificationState(panes, status), [panes, status]);
    const nativeHerd = React.useMemo(
        () => lifecycleCatalogAvailable && herd.mode === 'attention' ? { ...herd, eventKey: 'attention:' } : herd,
        [herd, lifecycleCatalogAvailable],
    );
    const boundPane = panes.find((pane) => pane.id === boundRealtimeSession());
    const voiceName = boundPane === undefined ? '' : herdPaneName(boundPane);
    const previous = React.useRef<Record<string, AgentLifecycle> | null>(null);
    const [presentation, setPresentation] = React.useState(herd);
    const [appActive, setAppActive] = React.useState(AppState.currentState === 'active');
    const vadStandbyEnabled = useLocalSetting('vadStandbyEnabled');
    const lifecycleNotificationLevel = useLocalSetting('lifecycleNotificationLevel');
    const keepalive = React.useRef(false);
    const herdActive = herd.mode === 'working' || herd.mode === 'attention';
    const notification = {
        herd: nativeLifecycleNotificationState(herdActive ? nativeHerd : presentation, lifecycleNotificationLevel),
        voiceState,
        voiceName,
        muted,
        agents: panes.map((pane) => ({
            id: pane.id,
            name: herdPaneName(pane),
            status: pane.agentStatus,
        })),
    };
    const native = React.useRef({ current: notification, connected: notification, authenticated: isAuthenticated, focus: undefined as string | null | undefined });
    native.current.current = notification;
    native.current.authenticated = isAuthenticated;
    if (status === 'connected') native.current.connected = notification;
    const sendNative = React.useCallback((focus: string | null, retain = false) => {
        const { herd: state, voiceState: voice, voiceName: name, muted: isMuted, agents } = retain
            ? native.current.connected : native.current.current;
        const visibleAgents = agents.map((pane) => ({ ...pane, focused: pane.id === focus }));
        if (focus !== null && !visibleAgents.some((pane) => pane.focused)) {
            visibleAgents.push({ id: focus, name: '', status: 'unknown', focused: true });
        }
        updateVoiceNotification(state, voice, name, isMuted, visibleAgents);
        refreshStatusChip({ herd: state, voiceState: voice, voiceName: name, muted: isMuted, agents: visibleAgents, voiceGeneration: realtimeGeneration() });
    }, []);

    React.useEffect(() => {
        const offAction = statusChip.on('action', ({ id }) => setChipActions((pending) => [...pending, id]));
        // Renew an unchanged post before its timeout, including a quiet busy herd.
        const refresh = setInterval(() => {
            if (native.current.authenticated) sendNative(focusedAgentRoute(), AppState.currentState !== 'active' && keepalive.current);
        }, 60_000);
        return () => { offAction(); clearInterval(refresh); };
    }, [sendNative]);

    React.useEffect(() => {
        // BYOKit may deliver a cold-start action before pairing/catalog hydration.
        if (!isAuthenticated || chipActions.length === 0) return;
        const ready = chipActions.filter((id) => !id.startsWith('open') || status === 'connected');
        if (ready.length === 0) return;
        setChipActions(chipActions.filter((id) => !ready.includes(id)));
        for (const id of ready) {
            if (id === 'open' || id.startsWith('open_')) {
                const route = panes.find((pane) => `open_${statusChipAgentKey(pane.id)}` === id)?.id;
                if (route !== undefined) navigateToSession(router, route);
                else router.dismissTo('/');
            } else if (id === 'talk') {
                void startRealtimeCapability();
            } else if (id === `stop_${statusChipVoiceKey(realtimeGeneration())}`) {
                stopRealtimeSession();
            } else if (id === `mute_${statusChipVoiceKey(realtimeGeneration())}_0`) {
                applyRealtimeMuted(false);
            } else if (id === `mute_${statusChipVoiceKey(realtimeGeneration())}_1`) {
                applyRealtimeMuted(true);
            }
        }
    }, [chipActions, isAuthenticated, panes, router, status]);

    React.useEffect(() => {
        let next = herd;
        if (lifecycleCatalogAvailable) {
            previous.current = null;
        } else {
            const before = previous.current;
            const { baseline, completed } = completionTransition(panes, status === 'connected', before);
            previous.current = baseline;
            if (before !== null && completed.length > 0) next = completionNotificationState(completed);
        }
        setPresentation((current) => sameNotification(current, next) ? current : next);
    }, [herd, lifecycleCatalogAvailable, panes, status]);

    React.useEffect(() => {
        if (!isAuthenticated) {
            if (keepalive.current) stopHerdKeepalive();
            keepalive.current = false;
            clearVoiceNotification();
            statusChip.clear();
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
        // The kernel never prompts for notifications itself: the Home primer
        // owns the one ask, so this only reads the current status.
        void notificationPermissionStatus().then(() => {
            if (!live) return;
            if (AppState.currentState !== 'active' && keepalive.current) {
                sendNative(null, true);
                return;
            }
            sendNative(focusedAgentRoute());
            if (herdActive && !keepalive.current) keepalive.current = startHerdKeepalive();
        });
        return () => { live = false; };
    }, [appActive, focusedRoute, herdActive, isAuthenticated, lifecycleNotificationLevel, muted, nativeHerd, panes, presentation, sendNative, status, voiceName, voiceState]);

    React.useEffect(() => {
        if (!isAuthenticated) return;
        const previous = native.current.focus;
        if (previous === focusedRoute) return;
        native.current.focus = focusedRoute;
        if (previous !== undefined || focusedRoute !== null) sendNative(focusedRoute, !appActive && keepalive.current);
    }, [appActive, focusedRoute, herdActive, isAuthenticated, sendNative]);

    React.useEffect(() => {
        if (!isAuthenticated) return;
        setAppActive(AppState.currentState === 'active');
        const subscription = AppState.addEventListener('change', (state) => {
            const active = state === 'active';
            if (!active) {
                native.current.focus = null;
                sendNative(null, keepalive.current);
            }
            setAppActive(active);
            if (active && herdActive) keepalive.current = startHerdKeepalive();
        });
        return () => subscription.remove();
    }, [herdActive, isAuthenticated, sendNative]);

    React.useEffect(() => () => {
        if (native.current.authenticated && native.current.focus) sendNative(null, keepalive.current);
    }, [sendNative]);

    React.useEffect(() => {
        if (Platform.OS === 'ios' && isAuthenticated && appActive && status === 'connected') {
            void registerNativePushNotifications();
        }
    }, [appActive, isAuthenticated, status]);

    React.useEffect(() => {
        if (isAuthenticated && appActive && vadStandbyEnabled && sessionCount > 0) {
            void retryVadStandby();
        }
    }, [appActive, isAuthenticated, sessionCount, vadStandbyEnabled]);

    return null;
}
