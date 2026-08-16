import { Wordmark } from '@/components/Wordmark';
import { AppState, NativeScrollEvent, NativeSyntheticEvent, View, ScrollView, Pressable, Platform } from 'react-native';
import { openExternalUrl } from '@/utils/openExternalUrl';
import * as React from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/state/connectionSettings';
import { getCachedHostedGrant, listPairedGrants } from '@/state/hostedE2ee';
import { useAuth } from '@/auth/AuthContext';
import { ItemList } from '@/components/ItemList';
import { useLocalSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { requestPermissionAndSubscribe, refreshPushState, type PushState } from '@/utils/pushNotifications';
import { loadAppConfig } from '@/sync/appConfig';
import { DeclarativeSettingsItems } from '@/plugins/DeclarativePluginSlot';
import {
    canPostPromotedNotifications,
    openPromotedNotificationSettings,
    supportsPromotedNotifications,
} from '@/../modules/voice-overlay';

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
    const runtimeVersion = typeof Constants.expoConfig?.runtimeVersion === 'string'
        ? Constants.expoConfig.runtimeVersion
        : undefined;
    const versionDetail = [
        appVersion,
        runtimeVersion ? `runtime ${runtimeVersion}` : undefined,
    ].filter(Boolean).join(' / ');
    const versionSubtitle = formatBuildSubtitle(getBuildConfig());
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const [showOfflineMachines, setShowOfflineMachines] = React.useState(false);
    const allMachinesWithOffline = useAllMachines({ includeOffline: true });
    const offlineMachineCount = React.useMemo(
        () => allMachinesWithOffline.filter(m => !isMachineOnline(m)).length,
        [allMachinesWithOffline]
    );
    const visibleMachines = React.useMemo(
        () => showOfflineMachines
            ? allMachinesWithOffline
            : allMachinesWithOffline.filter(isMachineOnline),
        [allMachinesWithOffline, showOfflineMachines]
    );
    const [pushState, setPushState] = React.useState<PushState>('unsupported');
    const [pushBusy, setPushBusy] = React.useState(false);
    const promotedNotificationsSupported = Platform.OS === 'android' && supportsPromotedNotifications();
    const [promotedNotificationsEnabled, setPromotedNotificationsEnabled] = React.useState(
        !promotedNotificationsSupported || canPostPromotedNotifications(),
    );
    const auth = useAuth();

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
        const confirmed = await Modal.confirm(
            'Switch to this machine?',
            'The app reconnects to it with the stored pairing. You can switch back the same way.',
            { confirmText: 'Switch' },
        );
        if (!confirmed) return;
        await saveConnectionSettings({
            ...getCachedConnectionSettings(),
            mode: 'hosted',
            relayUrl: grant.relayUrl,
            machineId,
            token: '',
            encryptionKey: '',
            selfhost: grant.source === 'selfhost' ? true : undefined,
        });
        await auth.login(grant.credential, grant.deviceKey.secretKey);
    }, [auth, router]);

    React.useEffect(() => {
        let cancelled = false;
        void refreshPushState().then((state) => {
            if (!cancelled) setPushState(state);
        });
        if (promotedNotificationsSupported) setPromotedNotificationsEnabled(canPostPromotedNotifications());
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active' && promotedNotificationsSupported) {
                setPromotedNotificationsEnabled(canPostPromotedNotifications());
            }
        });
        return () => {
            cancelled = true;
            subscription.remove();
        };
    }, [promotedNotificationsSupported]);

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

            {/* Machines (sorted: online first, then last seen desc) */}
            {allMachinesWithOffline.length > 0 && (
                <ItemGroup title={t('settings.machines')}>
                    {visibleMachines.map((machine) => {
                        const isOnline = isMachineOnline(machine);
                        const host = machine.metadata?.host;
                        const displayName = machine.metadata?.displayName;
                        const pairedName = getCachedHostedGrant(machine.id)?.machineName;
                        const safeHost = host && !/^machine[-_]/i.test(host) ? host : undefined;
                        const platform = machine.metadata?.platform || '';

                        const title = displayName || pairedName || safeHost || 'Paired computer';

                        // Internal machine ids are routing state, never user-facing names.
                        let subtitle = '';
                        if (displayName && safeHost && displayName !== safeHost) {
                            subtitle = safeHost;
                        }
                        if (platform) {
                            subtitle = subtitle ? `${subtitle} • ${platform}` : platform;
                        }
                        subtitle = subtitle ? `${subtitle} • ${isOnline ? t('status.online') : t('status.offline')}` : (isOnline ? t('status.online') : t('status.offline'));

                        return (
                            <Item
                                key={machine.id}
                                title={title}
                                subtitle={subtitle}
                                icon={
                                    <Ionicons
                                        name="desktop-outline"
                                        size={29}
                                        color={isOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
                                    />
                                }
                                onPress={() => void openMachine(machine.id)}
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
                </ItemGroup>
            )}

            {/* Paired self-host machines that have not connected yet don't appear in the live list */}
            <PairedSelfhostMachines onSwitch={(id) => void openMachine(id)} existing={allMachinesWithOffline.map((m) => m.id)} />

            <ItemGroup title="App and plugins">
                {getCachedConnectionSettings().mode === 'local' && (
                    <Item
                        title="Local development connection"
                        subtitle="Advanced fixture settings"
                        icon={<Ionicons name="link-outline" size={29} color="#FF9500" />}
                        onPress={() => router.push('/settings/connection' as any)}
                    />
                )}
                {Platform.OS === 'android' && (
                    <Item
                        title="Connect over SSH"
                        subtitle="Tunnel to a box you already SSH into"
                        icon={<Ionicons name="terminal-outline" size={29} color="#8E8E93" />}
                        onPress={() => router.push('/settings/ssh' as any)}
                    />
                )}
                <Item
                    title="Plugins"
                    subtitle="Native UI and capabilities installed through Herdr"
                    icon={<Ionicons name="extension-puzzle-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/plugins' as any)}
                />
                <DeclarativeSettingsItems />
                <Item
                    title="Appearance"
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title="Preferences"
                    subtitle="Recent activity and inactive sessions"
                    icon={<Ionicons name="options-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/settings/features')}
                />
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
                {docsBase && <Item title="Connect a computer" icon={<Ionicons name="desktop-outline" size={29} color="#007AFF" />} onPress={() => openExternalUrl(`${docsBase}/setup`)} />}
                {docsBase && <Item title="Troubleshooting" icon={<Ionicons name="help-circle-outline" size={29} color="#FF9500" />} onPress={() => openExternalUrl(`${docsBase}/docs/troubleshooting`)} />}
                {docsBase && <Item title="Privacy policy" icon={<Ionicons name="shield-checkmark-outline" size={29} color="#5856D6" />} onPress={() => openExternalUrl(`${docsBase}/docs/privacy`)} />}
                <Item
                    title="Redacted diagnostics"
                    subtitle={`Connection: ${pushState === 'unsupported' ? 'available in muxr doctor' : 'app active'} · Provider details hidden`}
                    icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => Modal.alert('Redacted diagnostics', `App ${versionDetail}\nConnection internals and secrets are intentionally hidden. Run muxr doctor on your computer for exportable redacted diagnostics.`)}
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

        </ItemList>
    );
});

/** Self-host paired machines that have no live connection row yet. */
const PairedSelfhostMachines = React.memo((props: { onSwitch: (machineId: string) => void; existing: string[] }) => {
    const { theme } = useUnistyles();
    const [paired, setPaired] = React.useState<{ id: string; name?: string }[]>([]);
    React.useEffect(() => {
        let cancelled = false;
        void listPairedGrants().then((grants) => {
            if (!cancelled) setPaired(grants.filter((g) => g.source === 'selfhost').map((g) => ({ id: g.machineId, name: g.machineName })));
        });
        return () => { cancelled = true; };
    }, []);
    const missing = paired.filter(({ id }) => !props.existing.includes(id));
    if (missing.length === 0) return null;
    return (
        <ItemGroup title="Paired machines">
            {missing.map(({ id, name }) => (
                <Item
                    key={id}
                    title={name || 'Paired computer'}
                    subtitle="self-hosted • tap to connect"
                    icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.status.disconnected} />}
                    onPress={() => props.onSwitch(id)}
                />
            ))}
        </ItemGroup>
    );
});
