import * as React from 'react';
import {
    View,
    Text,
    Pressable,
    Platform,
    Keyboard,
    TextInput,
    NativeScrollEvent,
    NativeSyntheticEvent,
    ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSocketStatus } from '@/catalog/store';
import { useSplitViewLayout } from '@/utils/responsive';
import { useRouter } from 'expo-router';
import { PluginSlot, DeclarativeHomeCards, DeclarativePhoneNavRow } from '@/plugins/ui';
import { pluginHref } from '@/plugins';
import { HomeDock, MOBILE_HOME_DOCK_CONTENT_INSET } from '@/spawn/ui';
import { HerdView } from './HerdView';
import { LiveTerminalsRow } from './LiveTerminalsRow';
import { SessionItem } from './SessionsList';
import { Header } from '@/components/navigation/Header';
import { HeaderLogo } from '@/components/HeaderLogo';
import { StatusDot } from '@/components/StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { useNewSessionDraft } from '@/spawn';
import { useStartSessionFromDraft } from '@/spawn';
import { listPairedGrants, type StoredHostedGrant } from '@/pairing/e2ee';
import { getCachedConnectionSettings, pairingTransport, saveConnectionSettings } from '@/connection';
import { useAuth } from '@/account/ui';
import { useVisibleSessionListViewData } from '../application/useVisibleSessionListViewData';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { Modal } from '@/modal';
import { realtimeMachineSwitchGuard, stopRealtimeSession } from '@/conversation/session';
import { connectionStatusPresentation, homeHeaderTitle, pairedMachineTitle } from '@/pairing/ui';
import { humanError } from '@/utils/errors';


const styles = StyleSheet.create((theme) => ({
    phoneContainer: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    phoneSceneStack: {
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: theme.colors.groupped.background,
    },
    phoneRoot: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    phoneHeader: {
        zIndex: 10,
        backgroundColor: 'transparent',
    },
    phoneHeaderOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
    },
    phoneBottomDockOverlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 30,
    },
    tabletDashboard: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    tabletDashboardContent: {
        flexGrow: 1,
        width: '100%',
        maxWidth: 1600,
        alignSelf: 'stretch',
        paddingBottom: 32,
    },
    tabletDashboardHeader: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        minHeight: 64,
        paddingHorizontal: 16,
        paddingBottom: 12,
    },
    tabletDashboardIdentity: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'flex-start',
        justifyContent: 'center',
    },
    tabletTitleContainer: {
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
    },
    titleText: {
        fontSize: 16,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    tabletTitleText: {
        fontSize: 26,
        lineHeight: 31,
    },
    recentSection: {
        width: '100%',
        maxWidth: 800,
        alignSelf: 'center',
        paddingTop: 12,
    },
    recentTitle: {
        paddingHorizontal: 16,
        paddingBottom: 6,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.5,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    machineTitleButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        maxWidth: '100%',
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusText: {
        fontSize: 11,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    tabletStatusText: {
        fontSize: 13,
        lineHeight: 18,
    },
    headerButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerActionGlass: {
        width: 40,
        height: 40,
        borderRadius: 20,
        overflow: 'hidden',
        // Glass blur does not composite on web: the native surface falls
        // back to a plain view, so compact web paints the solid control
        // fill itself. Native keeps the live blur untouched.
        ...Platform.select({
            web: {
                backgroundColor: theme.colors.glass.backgroundStrong,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.glass.border,
            },
            default: {},
        }),
    },
    headerActionButton: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerSearch: {
        width: '100%',
        height: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 4,
    },
    headerSearchInput: {
        flex: 1,
        minWidth: 0,
        height: 40,
        paddingVertical: 0,
        color: theme.colors.text,
        fontSize: 16,
        ...Typography.default(),
    },
}));

// Header title component with connection status and the active saved pairing.
const HeaderTitle = React.memo(({ large = false }: { large?: boolean }) => {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    const auth = useAuth();
    const [pairedGrants, setPairedGrants] = React.useState<StoredHostedGrant[]>([]);
    const [activeMachineId, setActiveMachineId] = React.useState(getCachedConnectionSettings().machineId);
    const [machinePickerOpen, setMachinePickerOpen] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        void listPairedGrants().then((grants) => {
            if (cancelled) return;
            setPairedGrants(grants);
            setActiveMachineId(getCachedConnectionSettings().machineId);
        });
        return () => { cancelled = true; };
    }, [socketStatus.status]);

    const activeGrant = pairedGrants.find((grant) => grant.machineId === activeMachineId);
    const machineName = pairedMachineTitle(activeGrant?.machineName);
    const machineOptions = React.useMemo<ModelMode[]>(() => pairedGrants.map((grant) => ({
        key: grant.machineId,
        name: grant.machineName || 'Paired computer',
        description: grant.machineId === activeMachineId ? 'Active' : pairingTransport(grant.relayUrl),
    })), [activeMachineId, pairedGrants]);

    const openMachinePicker = React.useCallback(async () => {
        try {
            const grants = await listPairedGrants();
            setPairedGrants(grants);
            setActiveMachineId(getCachedConnectionSettings().machineId);
            setMachinePickerOpen(true);
        } catch (cause) {
            Modal.alert('Could not load machines', humanError(cause).message);
        }
    }, []);

    const switchMachine = React.useCallback(async (option: ModelMode) => {
        if (option.key === activeMachineId) return;
        const grant = pairedGrants.find((entry) => entry.machineId === option.key);
        if (grant === undefined) return;
        if (!realtimeMachineSwitchGuard(grant.machineId).allowed) {
            const confirmed = await Modal.confirm(
                'End voice and switch?',
                'Realtime voice stays pinned to the computer where it started.',
                { confirmText: 'End voice and switch', destructive: true },
            );
            if (!confirmed) return;
            stopRealtimeSession();
        }
        try {
            await saveConnectionSettings({
                ...getCachedConnectionSettings(),
                mode: 'hosted',
                relayUrl: grant.relayUrl,
                machineId: grant.machineId,
                token: '',
                selfhost: grant.source === 'selfhost' ? true : undefined,
            });
            await auth.login(grant.credential, grant.deviceKey.secretKey);
            setActiveMachineId(grant.machineId);
        } catch (cause) {
            Modal.alert('Could not switch machine', humanError(cause).message);
        }
    }, [activeMachineId, auth, pairedGrants]);

    const connectionStatus = React.useMemo(
        () => connectionStatusPresentation(socketStatus, theme),
        [socketStatus, theme],
    );

    const title = homeHeaderTitle(
        'sessions',
        undefined,
        activeGrant ? pairedMachineTitle(activeGrant.machineName) : undefined,
    );

    return (
        <View style={[styles.titleContainer, large && styles.tabletTitleContainer]}>
            {pairedGrants.length > 1 ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Switch machine, current ${machineName}`}
                    onPress={() => { void openMachinePicker(); }}
                    style={styles.machineTitleButton}
                >
                    <Text style={[styles.titleText, large && styles.tabletTitleText]} numberOfLines={1}>{title}</Text>
                    <Ionicons name="chevron-down" size={13} color={theme.colors.header.tint} />
                </Pressable>
            ) : (
                <Text style={[styles.titleText, large && styles.tabletTitleText]} numberOfLines={1}>{title}</Text>
            )}
            {connectionStatus.text && (
                <View style={styles.statusContainer}>
                    <StatusDot color={connectionStatus.color} isPulsing={connectionStatus.isPulsing} size={6} style={{ marginRight: 4 }} />
                    <Text numberOfLines={1} style={[styles.statusText, large && styles.tabletStatusText, { color: connectionStatus.color }]}>{connectionStatus.text}</Text>
                </View>
            )}
            <OptionSheet
                visible={machinePickerOpen}
                title="Switch machine"
                options={machineOptions}
                selectedKey={activeMachineId}
                onSelect={(option) => { void switchMachine(option); }}
                onClose={() => setMachinePickerOpen(false)}
            />
        </View>
    );
});

const HeaderSearch = React.memo(({
    value,
    onChangeText,
}: {
    value: string;
    onChangeText: (value: string) => void;
}) => {
    const { theme } = useUnistyles();

    return (
        <View style={styles.headerSearch}>
            <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
            <TextInput
                autoFocus
                value={value}
                onChangeText={onChangeText}
                placeholder={t('tools.names.search')}
                placeholderTextColor={theme.colors.textSecondary}
                selectionColor={theme.colors.text}
                returnKeyType="search"
                autoCorrect={false}
                style={styles.headerSearchInput}
            />
        </View>
    );
});

// Header right buttons - search and settings, same composition everywhere.
const HeaderRight = React.memo(({
    searchActive,
    onSearchPress,
}: {
    searchActive: boolean;
    onSearchPress: () => void;
}) => {
    const router = useRouter();
    const { theme } = useUnistyles();

    return (
        <View style={styles.headerActions}>
            <MobileGlassSurface nativeEffect interactive style={styles.headerActionGlass}>
                <Pressable
                    onPress={onSearchPress}
                    style={styles.headerActionButton}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('tools.names.search')}
                >
                    <Ionicons
                        name={searchActive ? 'close' : 'search'}
                        size={searchActive ? 24 : 21}
                        color={theme.colors.header.tint}
                    />
                </Pressable>
            </MobileGlassSurface>
            <MobileGlassSurface nativeEffect interactive style={styles.headerActionGlass}>
                <Pressable
                    onPress={() => router.push('/settings')}
                    style={styles.headerActionButton}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.title')}
                >
                    <Ionicons name="settings-outline" size={21} color={theme.colors.header.tint} />
                </Pressable>
            </MobileGlassSurface>
        </View>
    );
});

export const MainView = React.memo(() => {
    useUnistyles();
    const useSplitView = useSplitViewLayout();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const { isStarting: isStartingHomeSession, startSession: startHomeSession } = useStartSessionFromDraft();
    const sessionListViewData = useVisibleSessionListViewData(true);
    const recentSessions = React.useMemo(
        () => (sessionListViewData ?? [])
            .flatMap((item) => item.type === 'session' ? [item.session] : [])
            .slice(0, 3),
        [sessionListViewData],
    );

    // Tab state management
    // NOTE: Zen tab removed - the feature never got to a useful state
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchActive, setSearchActive] = React.useState(false);
    const [homePrompt, setHomePrompt] = React.useState(() => useNewSessionDraft.getState().input);
    // The draft store (not this component state) owns the prompt, so text
    // survives the compact/split remount across the 900px breakpoint.
    const handleHomePromptChange = React.useCallback((value: string) => {
        setHomePrompt(value);
        useNewSessionDraft.getState().setInput(value);
    }, []);
    const [headerBackdropVisible, setHeaderBackdropVisible] = React.useState(false);
    const headerBackdropVisibleRef = React.useRef(false);
    const topContentInset = safeArea.top
        + MOBILE_GLASS_HEADER_HEIGHT
        + 12;
    const bottomContentInset = searchActive ? 16 : MOBILE_HOME_DOCK_CONTENT_INSET;

    const handleHomePromptSubmit = React.useCallback(async (): Promise<boolean> => {
        const prompt = homePrompt.trim();
        const attachments = useNewSessionDraft.getState().attachments;
        if (!prompt && attachments.length === 0) {
            return false;
        }
        useNewSessionDraft.getState().setInput(prompt);
        Keyboard.dismiss();
        const sessionId = await startHomeSession();
        if (sessionId) setHomePrompt('');
        return sessionId !== null;
    }, [homePrompt, startHomeSession]);

    // Opening a session with no prompt is a deliberate choice: pick the agent,
    // directory and worktree, then write once it is up.
    const handleStartBlankSession = React.useCallback(async (): Promise<boolean> => {
        Keyboard.dismiss();
        return await startHomeSession({ blank: true }) !== null;
    }, [startHomeSession]);

    const handleSearchPress = React.useCallback(() => {
        setSearchActive((currentValue) => {
            if (currentValue) {
                setSearchQuery('');
                Keyboard.dismiss();
            }
            return !currentValue;
        });
    }, []);

    const handleContentScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const nextVisible = event.nativeEvent.contentOffset.y > 12;
        if (nextVisible === headerBackdropVisibleRef.current) {
            return;
        }
        headerBackdropVisibleRef.current = nextVisible;
        setHeaderBackdropVisible(nextVisible);
    }, []);

    // In split view, the sidebar is the only navigator. The landing pane is
    // content: identity, live previews, and home cards. Spaces never duplicate
    // here because selecting them belongs to the permanent sidebar.
    if (useSplitView) {
        return (
            <View style={styles.tabletDashboard}>
                <ScrollView
                    onScroll={handleContentScroll}
                    scrollEventThrottle={16}
                    contentContainerStyle={[
                        styles.tabletDashboardContent,
                        {
                            paddingTop: topContentInset,
                            paddingBottom: safeArea.bottom + 32,
                        },
                    ]}
                >
                    <View style={styles.tabletDashboardHeader}>
                        <View style={styles.tabletDashboardIdentity}>
                            <HeaderLogo />
                            <HeaderTitle large />
                        </View>
                    </View>
                    <LiveTerminalsRow visibilityTop={safeArea.top} visibilityBottomInset={safeArea.bottom} />
                    <PluginSlot slot="home.cards" context={{}} />
                    <DeclarativeHomeCards />
                    {recentSessions.length > 0 && (
                        <View style={styles.recentSection}>
                            <Text style={styles.recentTitle}>Recent</Text>
                            {recentSessions.map((session, index) => (
                                <SessionItem
                                    key={session.id}
                                    session={session}
                                    isFirst={index === 0}
                                    isLast={index === recentSessions.length - 1}
                                    isSingle={recentSessions.length === 1}
                                />
                            ))}
                        </View>
                    )}
                </ScrollView>
            </View>
        );
    }

    // Regular phone mode: the native composition everywhere. Width chooses
    // this density (see useSplitViewLayout); settings and plugin
    // destinations are routes, so browser back works like native back.
    const phoneHeader = (
        <View style={[styles.phoneHeader, styles.phoneHeaderOverlay]}>
            <Header
                title={searchActive
                    ? <HeaderSearch value={searchQuery} onChangeText={setSearchQuery} />
                    : <HeaderTitle />}
                headerRight={() => (
                    <HeaderRight
                        searchActive={searchActive}
                        onSearchPress={handleSearchPress}
                    />
                )}
                headerRightGlass={false}
                headerLeft={() => <HeaderLogo />}
                headerLeftGlass={true}
                headerBackdropVisible={headerBackdropVisible}
                headerShadowVisible={false}
                headerTransparent={true}
            />
        </View>
    );

    return (
        <View style={styles.phoneRoot}>
            <View style={styles.phoneContainer}>
                <View style={styles.phoneSceneStack}>
                    <HerdView
                        topContentInset={topContentInset}
                        bottomContentInset={bottomContentInset}
                        header={<>
                            <PluginSlot slot="home.cards" context={{}} />
                            <DeclarativeHomeCards />
                            <DeclarativePhoneNavRow onSelect={(pluginId, contentId) => router.push(pluginHref(pluginId, contentId))} />
                        </>}
                        onScroll={handleContentScroll}
                        searchQuery={searchQuery}
                    />
                </View>
                {phoneHeader}
            </View>
            <View pointerEvents="box-none" style={styles.phoneBottomDockOverlay}>
                {!searchActive && (
                    <HomeDock
                        prompt={homePrompt}
                            onPromptChange={handleHomePromptChange}
                        onSubmit={handleHomePromptSubmit}
                        onStartBlank={handleStartBlankSession}
                        isSubmitting={isStartingHomeSession}
                    />
                )}
            </View>
        </View>
    );
});
