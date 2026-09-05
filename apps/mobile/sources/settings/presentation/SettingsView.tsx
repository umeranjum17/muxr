import { Wordmark } from '@/components/Wordmark';
import { AppState, Linking, NativeScrollEvent, NativeSyntheticEvent, View, ScrollView, Pressable, Platform, Text } from 'react-native';
import { openExternalUrl } from '@/utils/openExternalUrl';
import * as React from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { getCachedConnectionSettings, pairingTransport, saveConnectionSettings } from '@/connection';
import { getCachedHostedGrant, listPairedGrants, removeHostedGrant } from '@/pairing/e2ee';
import { forgetMachine as forgetPairedMachine, isMachineOnline } from '@/pairing';
import { useAuth } from '@/account/ui';
import { ItemList } from '@/components/ItemList';
import { useLocalSettingMutable } from '@/catalog/store';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useAllMachines } from '@/catalog/store';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { requestPermissionAndSubscribe, refreshPushState, type PushState } from '@/utils/pushNotifications';
import { loadAppConfig } from '@/catalog/infrastructure/appConfig';
import { formatConnectionDiagnosticsForReport } from '@/catalog/infrastructure/connectionDiagnostics';
import { knownHostVersion } from '@/utils/versionStatus';
import { requestNotificationPermission } from '@/utils/microphonePermissions';
import { registerNativePushNotifications } from '@/utils/nativePushNotifications';
import { DeclarativeSettingsItems } from '@/plugins/ui';
import {
    canPostPromotedNotifications,
    openBackgroundActivitySettings,
    openPromotedNotificationSettings,
    supportsPromotedNotifications,
} from '@/../modules/voice-overlay';
import {
    collaborationSummary,
    hasMachineCollaboration,
    loadCollaborationIntent,
    type CollaborationIntent,
} from '@/collaboration';
import { realtimeMachineSwitchGuard, stopRealtimeSession } from '@/conversation/session';
import { useRealtimeAppControl } from '@/conversation/application/realtimeAppControl';

type BuildConfig = {
    buildCommitSha?: unknown;
    buildCommitTimestamp?: unknown;
};

function getBuildConfig(): BuildConfig {
    const appConfig = Constants.expoConfig?.extra?.app;
    return appConfig && typeof appConfig === 'object' ? appConfig as BuildConfig : {};
}

function formatUtcTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:\d{2}Z$/, 'Z')
        .replace('T', ' ')
        .replace('Z', ' UTC');
}

function formatBuildSubtitle(buildConfig: BuildConfig): string | undefined {
    const commitTimestamp = typeof buildConfig.buildCommitTimestamp === 'string'
        ? formatUtcTimestamp(buildConfig.buildCommitTimestamp)
        : undefined;
    const commitSha = typeof buildConfig.buildCommitSha === 'string'
        ? buildConfig.buildCommitSha.slice(0, 7)
        : undefined;

    if (!commitTimestamp && !commitSha) {
        return undefined;
    }

    return [
        commitTimestamp ? `Commit ${commitTimestamp}` : 'Commit',
        commitSha,
    ].filter(Boolean).join(' / ');
}

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
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const openConnection = React.useCallback(() => router.push('/settings/connection' as never), [router]);
    const openVoice = React.useCallback(() => router.push('/settings/voice' as never), [router]);
    const openPlugins = React.useCallback(() => router.push('/settings/plugins' as never), [router]);
    const openAppearance = React.useCallback(() => router.push('/settings/appearance' as never), [router]);
    const openPreferences = React.useCallback(() => router.push('/settings/features' as never), [router]);
    const openNotifications = React.useCallback(() => router.push('/settings/notifications' as never), [router]);
    useRealtimeAppControl('Connection', openConnection, '/settings');
    useRealtimeAppControl('Realtime voice', openVoice, '/settings');
    useRealtimeAppControl('Plugins', openPlugins, '/settings');
    useRealtimeAppControl('Appearance', openAppearance, '/settings');
    useRealtimeAppControl('Preferences', openPreferences, '/settings');
    useRealtimeAppControl('Agent notifications', openNotifications, '/settings');
    const runtimeVersion = typeof Constants.expoConfig?.runtimeVersion === 'string'
        ? Constants.expoConfig.runtimeVersion
        : undefined;
    const versionDetail = [
        appVersion,
        runtimeVersion ? `runtime ${runtimeVersion}` : undefined,
    ].filter(Boolean).join(' / ');
    const versionSubtitle = formatBuildSubtitle(getBuildConfig());
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const lifecycleNotificationLevel = useLocalSettingMutable('lifecycleNotificationLevel')[0];
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
    const [pushBusy, setPushBusy] = React.useState(false);
    const promotedNotificationsSupported = Platform.OS === 'android' && supportsPromotedNotifications();
    const [promotedNotificationsEnabled, setPromotedNotificationsEnabled] = React.useState(
        !promotedNotificationsSupported || canPostPromotedNotifications(),
    );
    const [iosNotificationsEnabled, setIosNotificationsEnabled] = React.useState(false);
    const auth = useAuth();
    const activeMachineId = getCachedConnectionSettings().machineId;

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
        const forgotten = await forgetPairedMachine({ machineId }, { removeGrant: removeHostedGrant });
        if (!forgotten.ok) return;
        const remaining = forgotten.remaining;
        setPairedGrants(remaining);
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

    React.useEffect(() => {
        let cancelled = false;
        void refreshPushState().then((state) => {
            if (!cancelled) setPushState(state);
        });
        if (promotedNotificationsSupported) setPromotedNotificationsEnabled(canPostPromotedNotifications());
        if (Platform.OS === 'ios') void requestNotificationPermission(false).then(setIosNotificationsEnabled);
        const subscription = AppState.addEventListener('change', (state) => {
            if (state !== 'active') return;
            if (promotedNotificationsSupported) setPromotedNotificationsEnabled(canPostPromotedNotifications());
            if (Platform.OS === 'ios') void requestNotificationPermission(false).then(setIosNotificationsEnabled);
        });
        return () => {
            cancelled = true;
            subscription.remove();
        };
    }, [promotedNotificationsSupported]);

    const handleIosNotifications = async () => {
        const granted = await requestNotificationPermission();
        setIosNotificationsEnabled(granted);
        if (granted) void registerNativePushNotifications();
        if (!granted && await Modal.confirm(
            'Enable notifications?',
            'Open iOS Settings to allow agent completion and attention alerts.',
            { confirmText: 'Open settings' },
        )) await Linking.openSettings();
    };

    const handlePushToggle = async () => {
        if (pushBusy) return;
        setPushBusy(true);
        try {
            await requestPermissionAndSubscribe();
            setPushState(await refreshPushState());
        } finally {
            setPushBusy(false);
        }
    };

    const pushSubtitle = (() => {
        switch (pushState) {
            case 'subscribed': return t('settings.pushSubtitleSubscribed');
            case 'denied': return t('settings.pushSubtitleDenied');
            case 'unsupported': return t('settings.pushSubtitleUnsupported');
            default: return t('settings.pushSubtitleDefault');
        }
    })();

    const appConfig = loadAppConfig();
    const docsBase = appConfig.publicBaseUrl?.replace(/\/$/, '');

    // Use the multi-click hook for version clicks
    const handleVersionClick = useMultiClick(() => {
        // Toggle dev mode
        const newDevMode = !devModeEnabled;
        setDevModeEnabled(newDevMode);
        Modal.alert(
            t('modals.developerMode'),
            newDevMode ? t('modals.developerModeEnabled') : t('modals.developerModeDisabled')
        );
    }, {
        requiredClicks: 10,
        resetTimeout: 2000
    });

    return (

        <ItemList
            style={{ paddingTop: 0 }}
            containerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            onScroll={onScroll}
            scrollEventThrottle={16}
        >
            {/* App Info Header */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View
                    style={{
                    alignItems: 'center',
                    paddingVertical: 24,
                    backgroundColor: theme.colors.surface,
                    marginTop: 16,
                    borderRadius: Platform.select({ web: 12, default: 16 }),
                    marginHorizontal: 16,
                    borderWidth: Platform.OS === 'web' ? 0 : 0.5,
                    borderColor: theme.colors.divider,
                }}>
                    <View style={{ marginBottom: 12 }}>
                        <Wordmark width={200} />
                    </View>
                </View>
            </View>

            {/* Hosted machines require a persisted grant; live transport rows
                cannot resurrect a pairing the user just forgot. */}
            <ItemGroup title={t('settings.machines')}>
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
                    const hostVersion = knownHostVersion(machine?.metadata?.muxrCliVersion);

                    const title = displayName || pairedName || safeHost || 'Paired computer';

                    // Internal machine ids are routing state, never user-facing names.
                    const subtitle = [
                        displayName && safeHost && displayName !== safeHost ? safeHost : undefined,
                        platform || undefined,
                        pairingTransport(grant?.relayUrl),
                        hostVersion === undefined ? undefined : `host ${hostVersion}`,
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
                    title="Connection"
                    subtitle="Status, transport, relay, and how to fix it"
                    icon={<Ionicons name="link-outline" size={29} color="#FF9500" />}
                    onPress={openConnection}
                />
                <Item
                    title="Realtime voice"
                    subtitle="Choose which provider runs on this machine"
                    icon={<Ionicons name="pulse-outline" size={29} color="#34C759" />}
                    onPress={openVoice}
                />
                <Item
                    title="Plugins"
                    subtitle="Native UI and capabilities installed through Herdr"
                    icon={<Ionicons name="extension-puzzle-outline" size={29} color="#5856D6" />}
                    onPress={openPlugins}
                />
                <DeclarativeSettingsItems />
                <Item
                    title="Appearance"
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={openAppearance}
                />
                <Item
                    title="Preferences"
                    subtitle="Recent activity and inactive sessions"
                    icon={<Ionicons name="options-outline" size={29} color="#FF9500" />}
                    onPress={openPreferences}
                />
                {Platform.OS !== 'web' && (
                    <Item
                        title="Agent notifications"
                        subtitle="Choose which lifecycle events may alert you"
                        detail={lifecycleNotificationLevel === 'off'
                            ? 'Off'
                            : lifecycleNotificationLevel === 'important' ? 'Important' : 'All activity'}
                        icon={<Ionicons name="notifications-outline" size={29} color="#FF9500" />}
                        onPress={openNotifications}
                        accessibilityLabel={`Agent notifications, ${lifecycleNotificationLevel === 'off'
                            ? 'Off'
                            : lifecycleNotificationLevel === 'important' ? 'Important' : 'All activity'}`}
                    />
                )}
                {Platform.OS === 'android' && (
                    <Item
                        title="Background connection"
                        subtitle="Allow background activity so Live stays connected when you leave muxr"
                        icon={<Ionicons name="battery-charging-outline" size={29} color="#34C759" />}
                        onPress={openBackgroundActivitySettings}
                    />
                )}
                {promotedNotificationsSupported && (
                    <Item
                        title="Live agent updates"
                        subtitle={promotedNotificationsEnabled
                            ? 'Working agents can appear in Android’s status-bar island'
                            : 'Enable Android Live Updates to restore the status-bar island'}
                        detail={promotedNotificationsEnabled ? t('plugins.on') : t('plugins.off')}
                        icon={<Ionicons name="pulse-outline" size={29} color="#34C759" />}
                        onPress={openPromotedNotificationSettings}
                    />
                )}
                {Platform.OS === 'ios' && (
                    <Item
                        title="Notification permission"
                        subtitle="Allow lifecycle alerts in iOS Settings"
                        detail={iosNotificationsEnabled ? t('plugins.on') : t('plugins.off')}
                        icon={<Ionicons name="notifications-outline" size={29} color="#FF9500" />}
                        onPress={() => void handleIosNotifications()}
                    />
                )}
                {Platform.OS === 'web' && (
                    <Item
                        title="Notifications"
                        subtitle={pushSubtitle}
                        detail={pushState}
                        icon={<Ionicons name="notifications-outline" size={29} color="#FF9500" />}
                        onPress={handlePushToggle}
                        loading={pushBusy}
                    />
                )}
            </ItemGroup>

            <ItemGroup title="Help and advanced" footer="Diagnostics never includes credentials, QR claims, machine keys, terminal text or internal identifiers.">
                {docsBase && <Item title="Connect a computer" icon={<Ionicons name="desktop-outline" size={29} color="#007AFF" />} onPress={() => openExternalUrl(`${docsBase}/docs/setup`)} />}
                {docsBase && <Item title="Troubleshooting" icon={<Ionicons name="help-circle-outline" size={29} color="#FF9500" />} onPress={() => openExternalUrl(`${docsBase}/docs/troubleshooting`)} />}
                <Item title="Contact support" subtitle="Public issue tracker" icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color="#34C759" />} onPress={() => openExternalUrl('https://github.com/umeranjum17/muxr/issues')} />
                {docsBase && <Item title="Privacy and deletion" subtitle="Policy, revocation and data removal" icon={<Ionicons name="shield-checkmark-outline" size={29} color="#5856D6" />} onPress={() => openExternalUrl(`${docsBase}/docs/privacy#retention-and-deletion`)} />}
                <Item
                    title="Redacted diagnostics"
                    subtitle={`Connection: ${pushState === 'unsupported' ? 'available in muxr doctor' : 'app active'} · Provider details hidden`}
                    icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => Modal.alert('Redacted diagnostics', `App ${versionDetail}\n${formatConnectionDiagnosticsForReport()}`)}
                />
                <Item
                    title={t('settings.whatsNew')}
                    icon={<Ionicons name="sparkles-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/changelog')}
                />
                {Platform.OS === 'ios' && (
                    <Item title="EULA" icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />} onPress={() => openExternalUrl('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')} />
                )}
                <Item
                    title={t('common.version')}
                    subtitle={versionSubtitle}
                    subtitleLines={2}
                    detail={versionDetail}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={handleVersionClick}
                    showChevron={false}
                />
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
