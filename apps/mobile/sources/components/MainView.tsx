import * as React from 'react';
import {
    View,
    ActivityIndicator,
    Text,
    Pressable,
    Platform,
    Keyboard,
    TextInput,
    NativeScrollEvent,
    NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSocketStatus } from '@/sync/storage';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { useIsTablet } from '@/utils/responsive';
import { useRouter } from 'expo-router';
import { EmptySessionsTablet } from './EmptySessionsTablet';
import { SessionsList } from './SessionsList';
import { TabBar, TabType } from './TabBar';
import { PluginSlot } from '@/plugins/PluginSlot';
import { DeclarativeHomeCards, DeclarativeNavigationItems, DeclarativePhoneNavRow } from '@/plugins/DeclarativePluginSlot';
import { pluginHref } from '@/plugins/pluginHref';
import { HomeDock, MOBILE_HOME_DOCK_CONTENT_INSET } from './HomeDock';
import { SettingsViewWrapper } from './SettingsViewWrapper';
import { HerdView } from './HerdView';
import { Header } from './navigation/Header';
import { HeaderLogo } from './HeaderLogo';
import { StatusDot } from './StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { MOBILE_GLASS_HEADER_HEIGHT } from './navigation/headerMetrics';
import { MobileGlassSurface } from './MobileGlass';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useStartSessionFromDraft } from '@/hooks/useStartSessionFromDraft';
import { currentDeviceAuthority } from '@/state/hostedE2ee';

interface MainViewProps {
    variant: 'phone' | 'sidebar';
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    phoneContainer: {
        flex: 1,
        backgroundColor: Platform.OS === 'web' ? 'transparent' : theme.colors.groupped.background,
    },
    phoneSceneStack: {
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: theme.colors.groupped.background,
    },
    phoneRoot: {
        flex: 1,
        backgroundColor: Platform.OS === 'web' ? 'transparent' : theme.colors.groupped.background,
    },
    phoneHeader: {
        zIndex: 10,
        backgroundColor: Platform.OS === 'web' ? theme.colors.groupped.background : 'transparent',
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
    sidebarContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 32,
    },
    tabletLoadingContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyStateContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'column',
        backgroundColor: theme.colors.groupped.background,
    },
    emptyStateContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    titleContainer: {
        flex: 1,
        alignItems: Platform.OS === 'web' ? 'center' : 'flex-start',
        justifyContent: Platform.OS === 'web' ? 'flex-start' : 'center',
    },
    titleText: {
        fontSize: Platform.OS === 'web' ? 17 : 16,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusText: {
        fontSize: Platform.OS === 'web' ? 12 : 11,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
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

// Tab header configuration
const TAB_TITLES = {
    sessions: 'tabs.sessions',
    settings: 'tabs.settings',
} as const;

// Active tabs
type ActiveTabType = TabType;

// Header title component with connection status
const HeaderTitle = React.memo(({ activeTab, pluginTitle }: { activeTab: ActiveTabType; pluginTitle?: string }) => {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();

    const connectionStatus = React.useMemo(() => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: theme.colors.status.connected,
                    isPulsing: false,
                    text: t('status.connected'),
                };
            case 'connecting':
                return {
                    color: theme.colors.status.connecting,
                    isPulsing: true,
                    text: t('status.connecting'),
                };
            case 'disconnected':
                return {
                    color: theme.colors.status.disconnected,
                    isPulsing: false,
                    text: t('status.disconnected'),
                };
            case 'error':
                return {
                    color: theme.colors.status.error,
                    isPulsing: false,
                    // socketError is only ever a permanent pairing failure — the
                    // nav header gets the short label, connection.tsx the sentence.
                    text: socketStatus.error !== null ? t('status.pairingIssue') : t('status.error'),
                };
            default:
                return {
                    color: theme.colors.status.default,
                    isPulsing: false,
                    text: '',
                };
        }
    }, [socketStatus, theme]);

    return (
        <View style={styles.titleContainer}>
            <Text style={styles.titleText}>
                {activeTab === 'plugin' ? pluginTitle : t(TAB_TITLES[activeTab])}
            </Text>
            {connectionStatus.text && (
                <View style={styles.statusContainer}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={{ marginRight: 4 }}
                    />
                    <Text numberOfLines={1} style={[styles.statusText, { color: connectionStatus.color }]}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
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

// Header right button - varies by tab
const HeaderRight = React.memo(({
    activeTab,
    searchActive,
    onSearchPress,
}: {
    activeTab: ActiveTabType;
    searchActive: boolean;
    onSearchPress: () => void;
}) => {
    const router = useRouter();
    const { theme } = useUnistyles();

    if (activeTab === 'sessions') {
        if (Platform.OS !== 'web') {
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
        }
        return currentDeviceAuthority() === 'control' ? (
            <View style={styles.headerActions}>
                <Pressable
                    onPress={() => router.navigate('/new-agent')}
                    hitSlop={15}
                    style={styles.headerButton}
                >
                    <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
                </Pressable>
            </View>
        ) : null;
    }

    if (activeTab === 'settings') {
        return Platform.OS === 'web' ? <View style={styles.headerButton} /> : null;
    }

    return null;
});

export const MainView = React.memo(({ variant }: MainViewProps) => {
    const { theme } = useUnistyles();
    const sessionListViewData = useVisibleSessionListViewData();
    const isTablet = useIsTablet();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const { isStarting: isStartingHomeSession, startSession: startHomeSession } = useStartSessionFromDraft();

    // Tab state management
    // NOTE: Zen tab removed - the feature never got to a useful state
    const [activeTab, setActiveTab] = React.useState<ActiveTabType>('sessions');
    const [pluginTab, setPluginTab] = React.useState<{ key: string; pluginId: string; contentId: string; label: string }>();
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchActive, setSearchActive] = React.useState(false);
    const [homePrompt, setHomePrompt] = React.useState('');
    const [headerBackdropVisible, setHeaderBackdropVisible] = React.useState(false);
    const headerBackdropVisibleRef = React.useRef(false);
    const showHeaderRight = activeTab !== 'settings';
    const topContentInset = Platform.OS === 'web'
        ? 0
        : safeArea.top
            + MOBILE_GLASS_HEADER_HEIGHT
            + 12;
    const bottomContentInset = Platform.OS === 'web'
        ? 0
        : searchActive ? 16 : MOBILE_HOME_DOCK_CONTENT_INSET;

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

    const handleSearchPress = React.useCallback(() => {
        setSearchActive((currentValue) => {
            if (currentValue) {
                setSearchQuery('');
                Keyboard.dismiss();
            }
            return !currentValue;
        });
    }, []);

    const handleTabPress = React.useCallback((tab: ActiveTabType) => {
        // This callback is intentionally independent of activeTab. Gesture
        // worklets can outlive the render that created them, so comparing with a
        // captured tab here can discard a newer tap or drag commit.
        headerBackdropVisibleRef.current = false;
        setHeaderBackdropVisible(false);
        setActiveTab((currentTab) => currentTab === tab ? currentTab : tab);
    }, []);

    const handleContentScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const nextVisible = event.nativeEvent.contentOffset.y > 12;
        if (nextVisible === headerBackdropVisibleRef.current) {
            return;
        }
        headerBackdropVisibleRef.current = nextVisible;
        setHeaderBackdropVisible(nextVisible);
    }, []);

    const renderWebTabContent = () => {
        switch (activeTab) {
            case 'plugin':
                return <PluginSlot slot="navigation.content" context={{ pluginId: pluginTab?.pluginId, contributionId: pluginTab?.contentId, topContentInset, bottomContentInset, onScroll: handleContentScroll }} />;
            case 'settings':
                return <SettingsViewWrapper topContentInset={topContentInset} bottomContentInset={bottomContentInset} onScroll={handleContentScroll} />;
            case 'sessions':
            default:
                return <HerdView topContentInset={topContentInset} onScroll={handleContentScroll} />;
        }
    };

    // Sidebar variant
    if (variant === 'sidebar') {
        // Loading state
        if (sessionListViewData === null) {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.tabletLoadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
            );
        }

        // Empty state
        if (sessionListViewData.length === 0) {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.emptyStateContainer}>
                        <EmptySessionsTablet />
                    </View>
                </View>
            );
        }

        // Sessions list
        return (
            <View style={styles.sidebarContentContainer}>
                <SessionsList />
            </View>
        );
    }

    // Phone variant
    // Tablet in phone mode - special case (when showing index view on tablets, show empty view)
    if (isTablet) {
        // Just show an empty view on tablets for the index view
        // The sessions list is shown in the sidebar, so the main area should be blank
        return <View style={styles.emptyStateContentContainer} />;
    }

    // Regular phone mode with tabs
    const phoneHeader = (
        <View style={[styles.phoneHeader, Platform.OS !== 'web' && styles.phoneHeaderOverlay]}>
            <Header
                title={searchActive && Platform.OS !== 'web'
                    ? <HeaderSearch value={searchQuery} onChangeText={setSearchQuery} />
                    : <HeaderTitle activeTab={activeTab} pluginTitle={pluginTab?.label} />}
                headerRight={showHeaderRight ? () => (
                    <HeaderRight
                        activeTab={activeTab}
                        searchActive={searchActive}
                        onSearchPress={handleSearchPress}
                    />
                ) : undefined}
                headerRightGlass={false}
                headerLeft={() => <HeaderLogo />}
                headerLeftGlass={Platform.OS !== 'web'}
                headerBackdropVisible={headerBackdropVisible}
                headerShadowVisible={false}
                headerTransparent={true}
            />
        </View>
    );

    return (
        <View style={styles.phoneRoot}>
            <View style={styles.phoneContainer}>
                {Platform.OS === 'web' && phoneHeader}
                {Platform.OS === 'web' ? renderWebTabContent() : (
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
                )}
                {Platform.OS !== 'web' && phoneHeader}
            </View>
            {Platform.OS === 'web' ? (
                <>
                    <TabBar activeTab={activeTab} onTabPress={handleTabPress}>
                        <DeclarativeNavigationItems activeKey={activeTab === 'plugin' ? pluginTab?.key : undefined} onSelect={(key, pluginId, contentId, label) => { setPluginTab({ key, pluginId, contentId, label }); handleTabPress('plugin'); }} />
                    </TabBar>
                </>
            ) : (
                <View pointerEvents="box-none" style={styles.phoneBottomDockOverlay}>
                    {!searchActive && (
                        <HomeDock
                            prompt={homePrompt}
                            onPromptChange={setHomePrompt}
                            onSubmit={handleHomePromptSubmit}
                            isSubmitting={isStartingHomeSession}
                        />
                    )}
                </View>
            )}
        </View>
    );
});
