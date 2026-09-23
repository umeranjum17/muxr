import { AppState, NativeScrollEvent, NativeSyntheticEvent, View, Pressable, Platform, Text } from 'react-native';
import { openExternalUrl } from '@/utils/openExternalUrl';
import * as React from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/connection';
import { getCachedHostedGrant, listPairedGrants, removeHostedGrant } from '@/pairing/e2ee';
import { forgetMachine as forgetPairedMachine, isMachineOnline } from '@/pairing';
import { useAuth } from '@/account/ui';
import { ItemList } from '@/components/ItemList';
import { useLocalSettingMutable, useSettingMutable, useSocketStatus, storage } from '@/catalog/store';
import { Modal } from '@/modal';
import { useAllMachines } from '@/catalog/store';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { refreshPushState, unsubscribeWebPush, updateWebPushNotificationLevel, type PushState } from '@/utils/pushNotifications';
import { resolveForgetPushAction } from '@/utils/pushForget';
import { loadAppConfig } from '@/catalog';
import { versionsMismatch } from '@/utils/versionStatus';
import { getAppVersion } from '@/utils/appVersion';
import { DeclarativeSettingsItems } from '@/plugins/ui';
import {
    collaborationSummary,
    hasMachineCollaboration,
    loadCollaborationIntent,
    type CollaborationIntent,
} from '@/collaboration';
import { realtimeMachineSwitchGuard, stopRealtimeSession } from '@/conversation/session';
import { useRealtimeAppControl } from '@/conversation';
import { FONT_STEPS, clampFontIndex } from '@/terminal';
import { browserNotificationSummary, phoneNotificationSummary } from './notificationSummary';

export const SettingsView = React.memo(function SettingsView({
    topContentInset = 0,
    bottomContentInset = 0,
    onScroll,
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const appVersion = getAppVersion();
    const openConnection = React.useCallback(() => router.push('/settings/connection' as never), [router]);
    const openVoice = React.useCallback(() => router.push('/settings/voice' as never), [router]);
    const openPlugins = React.useCallback(() => router.push('/settings/plugins' as never), [router]);
    const openAppearance = React.useCallback(() => router.push('/settings/appearance' as never), [router]);
    const openPreferences = React.useCallback(() => router.push('/settings/features' as never), [router]);
    const openNotifications = React.useCallback(() => router.push('/settings/notifications' as never), [router]);
    const openGestures = React.useCallback(() => router.push('/settings/gestures' as never), [router]);
    useRealtimeAppControl('Connection', openConnection, '/settings');
    useRealtimeAppControl('Voice & dictation', openVoice, '/settings');
    useRealtimeAppControl('Plugins', openPlugins, '/settings');
    useRealtimeAppControl('Appearance', openAppearance, '/settings');
    useRealtimeAppControl('Preferences', openPreferences, '/settings');
    useRealtimeAppControl('Notifications', openNotifications, '/settings');
    useRealtimeAppControl('Gestures', openGestures, '/settings');
    const lifecycleNotificationLevel = useLocalSettingMutable('lifecycleNotificationLevel')[0];
    const themePreference = useLocalSettingMutable('themePreference')[0];
    const terminalFontSize = FONT_STEPS[clampFontIndex(useLocalSettingMutable('terminalFontIndex')[0])];
    const sortSessionsByActivity = useSettingMutable('sortSessionsByActivity')[0];
    const swipeFingers = useLocalSettingMutable('terminalSwipeFingers')[0];
    const pinchZoom = useLocalSettingMutable('terminalPinchZoom')[0];
    const swipeText = swipeFingers === 'off' ? 'Swipe off' : `${swipeFingers === 'two' ? 'Two-finger' : 'One-finger'} swipe`;
    const socketStatus = useSocketStatus().status;
    const socketStatusText = socketStatus === 'connected' ? 'Connected' : socketStatus === 'connecting' ? 'Connecting' : 'Offline';
    const themePreferenceText = themePreference === 'adaptive'
        ? t('settingsAppearance.themeOptions.adaptive')
        : themePreference === 'light' ? t('settingsAppearance.themeOptions.light') : t('settingsAppearance.themeOptions.dark');
    const [showOfflineMachines, setShowOfflineMachines] = React.useState(false);
    const allMachinesWithOffline = useAllMachines({ includeOffline: true });
    const offlineMachineCount = React.useMemo(
        () => allMachinesWithOffline.filter(m => !isMachineOnline(m)).length,
        [allMachinesWithOffline]
    );
    // The picker is the union of the live list and the persisted pairing
    // grants: the live list is empty whenever the host is down, but switching
    // and pairing must stay reachable exactly then. Grants load on mount —
    // this view remounts every time the Settings tab is opened.
    const [pairedGrants, setPairedGrants] = React.useState<Awaited<ReturnType<typeof listPairedGrants>>>([]);
    const [collaborationIntent, setCollaborationIntent] = React.useState<CollaborationIntent>({
        version: 1, selectedMachineIds: [], machines: [], edges: [],
    });
    useFocusEffect(React.useCallback(() => {
        let cancelled = false;
        void Promise.all([listPairedGrants(), loadCollaborationIntent()]).then(([grants, collaboration]) => {
            if (!cancelled) {
                setPairedGrants(grants);
                setCollaborationIntent(collaboration);
            }
        });
        return () => { cancelled = true; };
    }, []));
    const machineRows = React.useMemo(() => {
        const rows: { id: string; live?: (typeof allMachinesWithOffline)[number] }[] = [];
        const listedIds = new Set<string>();
        const pairedIds = new Set(pairedGrants.map((grant) => grant.machineId));
        const hosted = getCachedConnectionSettings().mode === 'hosted';
        for (const machine of allMachinesWithOffline) {
            if ((hosted && !pairedIds.has(machine.id)) || (!showOfflineMachines && !isMachineOnline(machine))) continue;
            listedIds.add(machine.id);
            rows.push({ id: machine.id, live: machine });
        }
        for (const grant of pairedGrants) {
            if (!listedIds.has(grant.machineId)) rows.push({ id: grant.machineId });
        }
        return rows;
    }, [allMachinesWithOffline, pairedGrants, showOfflineMachines]);
    const [pushState, setPushState] = React.useState<PushState>('unsupported');
    const [notificationsAllowed, setNotificationsAllowed] = React.useState(true);
    const auth = useAuth();
    const activeMachineId = getCachedConnectionSettings().machineId;
    const versionMismatch = versionsMismatch(appVersion, allMachinesWithOffline.find((machine) => machine.id === activeMachineId)?.metadata?.muxrCliVersion);

    const openMachine = React.useCallback(async (machineId: string) => {
        const active = getCachedConnectionSettings().machineId;
        if (machineId === active) {
            router.push(`/machine/${machineId}`);
            return;
        }
        const grant = getCachedHostedGrant(machineId) ?? (await listPairedGrants()).find((g) => g.machineId === machineId);
        if (grant === undefined) {
            router.push(`/machine/${machineId}`);
            return;
        }
        const voiceActive = !realtimeMachineSwitchGuard(machineId).allowed;
        const confirmed = await Modal.confirm(
            voiceActive ? 'End voice and switch?' : 'Switch to this machine?',
            voiceActive
                ? 'Realtime voice stays pinned to the computer where it started.'
                : 'The app reconnects to it with the stored pairing. You can switch back the same way.',
            { confirmText: voiceActive ? 'End voice and switch' : 'Switch', destructive: voiceActive },
        );
        if (!confirmed) return;
        if (voiceActive) stopRealtimeSession();
        await saveConnectionSettings({
            ...getCachedConnectionSettings(),
            mode: 'hosted',
            relayUrl: grant.relayUrl,
            machineId,
            token: '',
            selfhost: grant.source === 'selfhost' ? true : undefined,
        });
        await auth.login(grant.credential, grant.deviceKey.secretKey);
    }, [auth, router]);

    const forgetMachine = React.useCallback(async (machineId: string, name: string) => {
        const collaborationWarning = hasMachineCollaboration(collaborationIntent, machineId)
            ? '\n\nComputer collaboration still exists. Forgetting this phone pairing does not revoke computer-to-computer access; disconnect collaboration first if you want that access removed.'
            : '';
        const voiceActive = machineId === getCachedConnectionSettings().machineId
            && !realtimeMachineSwitchGuard('').allowed;
        const voiceWarning = voiceActive ? '\n\nRealtime voice on this computer will end.' : '';
        const confirmed = await Modal.confirm(
            `Forget ${name}?`,
            `This removes the pairing from this phone. The machine keeps running, and you can pair it again later.${collaborationWarning}${voiceWarning}`,
            { confirmText: 'Forget', destructive: true },
        );
        if (!confirmed) return;
        if (voiceActive) stopRealtimeSession();
        const wasCurrent = machineId === getCachedConnectionSettings().machineId;
        // Capture the web-push credential while the grant is still cached:
        // the server-side endpoint can only be deleted with it, and the
        // grant is gone after forgetPairedMachine runs.
        const preSettings = getCachedConnectionSettings();
        const preGrant = preSettings.mode === 'hosted' ? getCachedHostedGrant(preSettings.machineId) : undefined;
        const preCredential = preGrant?.credential ?? preSettings.token;
        const forgotten = await forgetPairedMachine({ machineId }, { removeGrant: removeHostedGrant });
        if (!forgotten.ok) return;
        const remaining = forgotten.remaining;
        setPairedGrants(remaining);
        // Forgetting the current machine of several must leave the survivors
        // subscribed: only the last machine takes the server endpoint with
        // it. A survivor rebinds the same browser endpoint under its own
        // grant below, or delivery-time authorization prunes it as a dead
        // grant and that machine's push silently stops.
        const pushAction = Platform.OS === 'web' && wasCurrent
            ? resolveForgetPushAction(true, remaining.length)
            : 'none';
        if (pushAction === 'delete-endpoint') {
            await unsubscribeWebPush({ credential: preCredential });
        }
        if (machineId !== getCachedConnectionSettings().machineId) return;
        const next = remaining[0];
        if (next === undefined) {
            await auth.logout();
            return;
        }
        await saveConnectionSettings({
            ...getCachedConnectionSettings(),
            mode: 'hosted', relayUrl: next.relayUrl, machineId: next.machineId,
            token: '', selfhost: next.source === 'selfhost' ? true : undefined,
        });
        await auth.login(next.credential, next.deviceKey.secretKey);
        if (pushAction === 'rebind-endpoint') {
            await updateWebPushNotificationLevel(storage.getState().localSettings.lifecycleNotificationLevel);
        }
    }, [auth, collaborationIntent]);

    const confirmLogout = React.useCallback(async () => {
        const collaborationWarning = collaborationIntent.selectedMachineIds.length > 0 || collaborationIntent.edges.length > 0
            ? '\n\nComputer collaboration stays active after logout. Disconnect collaboration first if you want computer-to-computer access revoked.'
            : '';
        const confirmed = await Modal.confirm(
            t('settingsAccount.logout'),
            `This signs out and removes this device’s pairing with every machine it has ever paired with. To reconnect, pair each machine again from \`muxr pair\`.${collaborationWarning}`,
            { confirmText: t('settingsAccount.logout'), destructive: true },
        );
        if (!confirmed) return;
        stopRealtimeSession();
        await auth.logout();
    }, [auth, collaborationIntent]);

    // Whether alerts can arrive changes on the Notifications screen and in the
    // system's settings, so read it whenever Settings comes back into view.
    useFocusEffect(React.useCallback(() => {
        let cancelled = false;
        const read = () => {
            if (Platform.OS === 'web') {
                void refreshPushState().then((state) => {
                    if (!cancelled) setPushState(state);
                });
            } else {
                void Notifications.getPermissionsAsync().then((permission) => {
                    if (!cancelled) setNotificationsAllowed(permission.granted);
                }, () => {});
            }
        };
        read();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') read();
        });
        return () => {
            cancelled = true;
            subscription.remove();
        };
    }, []));

    const appConfig = loadAppConfig();
    const docsBase = appConfig.publicBaseUrl?.replace(/\/$/, '');

    return (

        <ItemList
            style={{ paddingTop: 0 }}
            containerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            onScroll={onScroll}
            scrollEventThrottle={16}
        >
            <ItemGroup title="Connection & updates">
                <Item
                    title="Connection"
                    subtitle={versionMismatch
                        ? 'App and host versions differ — review updates'
                        : 'Health, installed versions and diagnostics for this device and computer'}
                    subtitleLines={0}
                    detail={versionMismatch ? 'Mismatch' : socketStatusText}
                    subtitleStyle={versionMismatch ? { color: theme.colors.text, fontWeight: '600' } : undefined}
                    icon={<Ionicons name={versionMismatch ? "warning-outline" : "link-outline"} size={29} color={versionMismatch ? theme.colors.box.warning.border : theme.colors.textSecondary} />}
                    onPress={openConnection}
                />
            </ItemGroup>

            {/* Hosted machines require a persisted grant; live transport rows
                cannot resurrect a pairing the user just forgot. */}
            <ItemGroup title={t('settings.machines')} footer="These computers are paired with this device. Tap one to switch; forgetting removes only this device's pairing.">
                {machineRows.map(({ id, live: machine }) => {
                    const isOnline = machine !== undefined && isMachineOnline(machine);
                    const host = machine?.metadata?.host;
                    const displayName = machine?.metadata?.displayName;
                    const grant = getCachedHostedGrant(id) ?? pairedGrants.find((entry) => entry.machineId === id);
                    const pairedName = grant?.machineName;
                    const status = machine === undefined && grant !== undefined
                        ? 'paired'
                        : isOnline ? t('status.online') : t('status.offline');
                    const safeHost = host && !/^machine[-_]/i.test(host) ? host : undefined;
                    const platform = machine?.metadata?.platform || '';

                    const title = displayName || pairedName || safeHost || 'Paired computer';

                    // Internal machine ids are routing state, never user-facing names.
                    const subtitle = [
                        displayName && safeHost && displayName !== safeHost ? safeHost : undefined,
                        platform || undefined,
                        status,
                    ].filter(Boolean).join(' • ');

                    return (
                        <Item
                            key={id}
                            title={title}
                            subtitle={subtitle}
                            rightElement={grant === undefined ? undefined : (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                    {id === activeMachineId && <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Active</Text>}
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`Forget ${title}`}
                                        hitSlop={10}
                                        onPress={(event) => { event.stopPropagation(); void forgetMachine(id, title); }}
                                    >
                                        <Ionicons name="trash-outline" size={19} color={theme.colors.textDestructive} />
                                    </Pressable>
                                </View>
                            )}
                            icon={
                                <Ionicons
                                    name="desktop-outline"
                                    size={29}
                                    color={isOnline
                                        ? theme.colors.status.connected
                                        : machine === undefined && grant !== undefined
                                          ? theme.colors.textSecondary
                                          : theme.colors.status.disconnected}
                                />
                            }
                            onPress={() => void openMachine(id)}
                        />
                    );
                })}
                {offlineMachineCount > 0 && (
                    <Item
                        title={showOfflineMachines
                            ? t('settings.hideOfflineMachines')
                            : t('settings.showOfflineMachines', { count: offlineMachineCount })}
                        onPress={() => setShowOfflineMachines(v => !v)}
                        showChevron={false}
                        titleStyle={{
                            textAlign: 'center',
                            color: theme.colors.textLink,
                        }}
                    />
                )}
                <Item
                    title="Pair another machine"
                    subtitle="Scan the QR or enter the short string from `muxr pair`"
                    icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/pair?source=settings')}
                />
                <Item
                    title="Computer collaboration"
                    subtitle="Let selected computers read agent output and send prompts"
                    detail={collaborationSummary(collaborationIntent)}
                    icon={<Ionicons name="git-network-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/collaboration' as any)}
                />
            </ItemGroup>
            <ItemGroup title="App and plugins">
                <Item
                    title={t('usage.title')}
                    subtitle="Tokens, cost and plan limits for this computer"
                    icon={<Ionicons name="speedometer-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/usage' as any)}
                />
                <Item
                    title="Plugins"
                    subtitle="Extensions installed through Herdr on the computer"
                    icon={<Ionicons name="extension-puzzle-outline" size={29} color="#5856D6" />}
                    onPress={openPlugins}
                />
                <Item
                    title="Plugin guide"
                    subtitle="Install, approve and configure extensions"
                    icon={<Ionicons name="book-outline" size={29} color="#5856D6" />}
                    onPress={() => openExternalUrl('https://github.com/umeranjum17/muxr/blob/main/docs/PLUGINS.md')}
                />
                <DeclarativeSettingsItems />
            </ItemGroup>

            <ItemGroup title="Display and alerts">
                <Item
                    title="Appearance"
                    subtitle={`${themePreferenceText} · Terminal ${terminalFontSize} pt`}
                    subtitleLines={2}
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={openAppearance}
                />
                <Item
                    title="Notifications"
                    subtitle={Platform.OS === 'web'
                        ? browserNotificationSummary(pushState, lifecycleNotificationLevel)
                        : phoneNotificationSummary(notificationsAllowed, lifecycleNotificationLevel)}
                    subtitleLines={2}
                    icon={<Ionicons name="notifications-outline" size={29} color="#FF9500" />}
                    onPress={openNotifications}
                />
            </ItemGroup>

            <ItemGroup title="Input">
                <Item
                    title="Preferences"
                    subtitle="Session order, inactive sessions and keyboard"
                    detail={sortSessionsByActivity ? 'Recent activity' : 'Created'}
                    icon={<Ionicons name="options-outline" size={29} color="#FF9500" />}
                    onPress={openPreferences}
                />
                <Item
                    title="Gestures"
                    subtitle={`${swipeText} · Pinch to zoom ${pinchZoom ? 'on' : 'off'}`}
                    subtitleLines={2}
                    icon={<Ionicons name="hand-left-outline" size={29} color="#007AFF" />}
                    onPress={openGestures}
                />
                <Item
                    title="Voice & dictation"
                    subtitle="Realtime provider, on-device dictation and wake-on-speech"
                    icon={<Ionicons name="pulse-outline" size={29} color="#34C759" />}
                    onPress={openVoice}
                />
            </ItemGroup>

            <ItemGroup title="About">
                <Item
                    title="Version"
                    subtitle="App version; host version and diagnostics are under Connection & updates"
                    detail={appVersion}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={openConnection}
                />
                <Item
                    title={t('settings.whatsNew')}
                    subtitle="Release notes for this version"
                    icon={<Ionicons name="sparkles-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/changelog')}
                />
                <Item title="Contact support" subtitle="Public issue tracker" icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color="#34C759" />} onPress={() => openExternalUrl('https://github.com/umeranjum17/muxr/issues')} />
                {docsBase && <Item title="Privacy and deletion" subtitle="Policy, revocation and data removal" icon={<Ionicons name="shield-checkmark-outline" size={29} color="#5856D6" />} onPress={() => openExternalUrl(`${docsBase}/docs/privacy#retention-and-deletion`)} />}
                {Platform.OS === 'ios' && (
                    <Item title="EULA" subtitle="Apple's standard licence for App Store apps" icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />} onPress={() => openExternalUrl('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')} />
                )}
            </ItemGroup>

            <ItemGroup>
                <Item
                    title={t('settingsAccount.logout')}
                    subtitle={t('settingsAccount.logoutSubtitle')}
                    icon={<Ionicons name="log-out-outline" size={29} color={theme.colors.textDestructive} />}
                    onPress={() => void confirmLogout()}
                    showChevron={false}
                />
            </ItemGroup>

        </ItemList>
    );
});
