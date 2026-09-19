import React from 'react';
import { View, Pressable, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, ViewToken } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, SessionRowData } from '@/catalog/store';
import { Ionicons } from '@expo/vector-icons';
import { sessionStateColors, unreadStateColors, vibingMessages } from '../application/sessionUtils';
import { Avatar } from '@/components/Avatar';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '../application/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { isSettledSession, SessionMetaLine } from './SessionRowParts';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSplitViewLayout } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from '@/components/UpdateBanner';
import { LiveTerminalsRow } from './LiveTerminalsRow';
import { layout } from '@/components/layout';
import { useNavigateToSession } from '../application/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { t } from '@/text';
import { SessionShortcutHintBadge } from '@/components/ShortcutHints';
import { ProviderIcon } from '@/components/ProviderIcon';
import { TerminalPreview } from '@/terminal/ui';
import {
    filterSessionList,
    sessionCardPlacement,
    sessionMachineCaption,
    sessionStateSentence,
    sessionSubtitleKind,
} from '../domain/sessionRowPresentation';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    sessionItem: {
        height: 100,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: 'transparent',
        // Long-press must open multi-select, not highlight the row's text.
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
    },
    sessionItemFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
    },
    sessionItemSingle: {
        borderRadius: 12,
    },
    sessionItemContainerFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    sessionItemContainerSingle: {
        borderRadius: 12,
        marginBottom: 12,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 12,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sessionShortcutBadge: {
        flexShrink: 0,
        marginLeft: 8,
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionSubtitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginBottom: 4,
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },

    // The card's live thumbnail: a real read of the pane's visible screen in
    // the slot the avatar used to own, with the avatar as a small badge so the
    // agent stays recognizable when the terminal is blank.
    previewBlock: {
        width: 80,
        height: 56,
        borderRadius: 10,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    previewAvatarFallback: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
    },
    previewAvatarBadge: {
        position: 'absolute',
        left: 4,
        bottom: 4,
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: theme.colors.surface,
        backgroundColor: theme.colors.surface,
    },

    avatarContainer: {
        position: 'relative',
        width: 20,
        height: 20,
    },
    draftIconContainer: {
        position: 'absolute',
        bottom: -3,
        right: -3,
        width: 12,
        height: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconOverlay: {
        color: theme.colors.textSecondary,
    },
    artifactsSection: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
    },
}));

export function SessionsList({
    topContentInset = 0,
    bottomContentInset = 128,
    onScroll,
    searchQuery = '',
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    searchQuery?: string;
} = {}) {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const sourceData = useVisibleSessionListViewData();
    const pathname = usePathname();
    const splitViewLayout = useSplitViewLayout();
    // Selection is derived once from pathname so the data array stays stable
    // across navigations. This keeps FlatList virtualization intact: only
    // the previously- and newly-selected rows re-render, instead of the
    // whole visible window.
    const selectedSessionId = React.useMemo<string | undefined>(() => {
        if (!splitViewLayout) return undefined;
        if (!pathname.startsWith('/session/')) return undefined;
        return pathname.split('/')[2];
    }, [splitViewLayout, pathname]);

    // Request review
    React.useEffect(() => {
        if (sourceData && sourceData.length > 0) {
            requestReview();
        }
    }, [sourceData && sourceData.length > 0]);

    const data = React.useMemo(
        () => filterSessionList(sourceData, searchQuery),
        [searchQuery, sourceData],
    );

    // Rows hand their snapshot cost to this set: a mounted-but-scrolled-away
    // card pauses its TerminalPreview, the same cadence the pane grid uses.
    const [visibleSessionIds, setVisibleSessionIds] = React.useState<ReadonlySet<string>>(() => new Set());
    const visibleKeyRef = React.useRef('');
    const onViewableItemsChanged = React.useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        const ids: string[] = [];
        for (const token of viewableItems) {
            const item = token.item as SessionListViewItem;
            if (item.type === 'session') ids.push(item.session.id);
        }
        const key = ids.join('|');
        if (key === visibleKeyRef.current) return;
        visibleKeyRef.current = key;
        setVisibleSessionIds(new Set(ids));
    }).current;
    const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 20 }).current;

    // Early return if no data yet
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';

            case 'session': return `session-${item.session.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item, index }: { item: SessionListViewItem, index: number }) => {
        switch (item.type) {
            case 'header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>
                            {item.title}
                        </Text>
                    </View>
                );

            case 'active-sessions':
                return (
                    <ActiveSessionsGroupCompact
                        sessions={item.sessions}
                        selectedSessionId={selectedSessionId}
                    />
                );

            case 'session':
                // Determine card styling based on position within date group
                const prevItem = index > 0 ? data[index - 1] : null;
                const nextItem = index < data.length - 1 ? data[index + 1] : null;

                const isFirst = prevItem?.type === 'header';
                const isLast = nextItem?.type === 'header' || nextItem == null || nextItem?.type === 'active-sessions';
                const isSingle = isFirst && isLast;
                const selected = item.session.id === selectedSessionId;

                return (
                    <SessionItem
                        session={item.session}
                        selected={selected}
                        isFirst={isFirst}
                        isLast={isLast}
                        isSingle={isSingle}
                        visible={visibleSessionIds.has(item.session.id)}
                    />
                );
        }
    }, [selectedSessionId, data, visibleSessionIds]);

    const HeaderComponent = React.useCallback(() => {
        return (
            <>
                <LiveTerminalsRow />
                <UpdateBanner />
            </>
        );
    }, []);

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={data}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    extraData={[selectedSessionId, visibleSessionIds]}
                    onViewableItemsChanged={onViewableItemsChanged}
                    viewabilityConfig={viewabilityConfig}
                    contentContainerStyle={{
                        paddingTop: topContentInset,
                        paddingBottom: safeArea.bottom + bottomContentInset,
                        maxWidth: layout.maxWidth,
                    }}
                    ListHeaderComponent={HeaderComponent}
                    ListEmptyComponent={searchQuery.trim() ? (
                        <View style={{ paddingTop: 48, alignItems: 'center' }}>
                            <Text style={styles.headerText}>{t('sessionHistory.empty')}</Text>
                        </View>
                    ) : null}
                    windowSize={5}
                    maxToRenderPerBatch={8}
                    initialNumToRender={12}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                />
            </View>
        </View>
    );
}

export const SessionItem = React.memo(({ session, selected, isFirst, isLast, isSingle, visible = true }: {
    session: SessionRowData;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
    /** False when the list scrolled the row out of view: pauses its snapshot. */
    visible?: boolean;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const baseStatus = sessionStateColors(session.state, theme);
    // Override to solid accent when session has unread results
    const status = session.hasUnread
        ? unreadStateColors(theme, baseStatus)
        : baseStatus;

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [session.state]);

    const { sentence, factual: factualStatus, elapsed } = sessionStateSentence(session, vibingMessage);

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [session.id, navigateToSession]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {};

    const settled = isSettledSession(session);
    const placement = sessionCardPlacement(isFirst, isLast, isSingle);
    const itemShape = {
        single: styles.sessionItemSingle,
        first: styles.sessionItemFirst,
        last: styles.sessionItemLast,
        middle: {},
    }[placement];
    const containerShape = {
        single: styles.sessionItemContainerSingle,
        first: styles.sessionItemContainerFirst,
        last: styles.sessionItemContainerLast,
        middle: {},
    }[placement];
    const subtitleKind = sessionSubtitleKind(session);
    const herdrBacked = session.clientId === 'herdr';
    const avatar = (
        <Avatar id={session.avatarId} size={herdrBacked ? 20 : 40} monochrome={!status.isConnected} flavor={session.flavor} clientId={session.clientId} />
    );
    const rowOpacity = settled ? 0.75 : 1;

    const row = (
        <Pressable
            style={({ pressed }) => [
                styles.sessionItem,
                { opacity: pressed ? 0.55 : rowOpacity },
                selected && styles.sessionItemSelected,
                itemShape,
            ]}
            onPress={handlePress}
            accessibilityRole="button"
            accessibilityState={{ selected: !!selected }}
            accessibilityLabel={`${session.name}, ${factualStatus}`}
            {...menuProps}
        >
            <View
                style={styles.previewBlock}
                accessible={false}
                importantForAccessibility="no-hide-descendants"
            >
                {herdrBacked ? (
                    // Working panes poll the visible screen; the rest take one
                    // snapshot per look. Paused with the app or the row.
                    <TerminalPreview
                        sessionId={session.id}
                        live={session.state === 'thinking'}
                        paused={!visible}
                        maxLines={6}
                        nonEmpty
                    />
                ) : (
                    <View style={styles.previewAvatarFallback} pointerEvents="none">
                        <View style={styles.avatarContainer}>
                            {avatar}
                            {session.hasDraft && (
                                <View style={styles.draftIconContainer}>
                                    <Ionicons
                                        name="create-outline"
                                        size={12}
                                        style={styles.draftIconOverlay}
                                    />
                                </View>
                            )}
                        </View>
                    </View>
                )}
                {herdrBacked && (
                    <View style={styles.previewAvatarBadge} pointerEvents="none">
                        {avatar}
                        {session.hasDraft && (
                            <View style={styles.draftIconContainer}>
                                <Ionicons
                                    name="create-outline"
                                    size={12}
                                    style={styles.draftIconOverlay}
                                />
                            </View>
                        )}
                    </View>
                )}
            </View>
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                    ]} numberOfLines={1}>
                        {session.name}
                    </Text>
                    <SessionShortcutHintBadge
                        sessionId={session.id}
                        style={styles.sessionShortcutBadge}
                    />
                </View>

                {subtitleKind === 'identity' && (
                    <View style={styles.sessionSubtitleRow}>
                        <ProviderIcon kind={session.providerKind} size={13} monochrome />
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {session.identityLine}
                        </Text>
                    </View>
                )}
                {subtitleKind === 'machine-path' && (
                    <SessionMetaLine segments={[{ text: sessionMachineCaption(session) }]} />
                )}
                {subtitleKind === 'subtitle' && (
                    <Text style={styles.sessionSubtitle} numberOfLines={1}>
                        {session.subtitle}
                    </Text>
                )}

                <View style={styles.statusRow}>
                    <View style={styles.statusDotContainer}>
                        <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                    </View>
                    {/* One dot, one sentence, quiet duration. Settled rows spend
                        no colour, so the eye lands on the one still working. */}
                    <SessionMetaLine
                        style={{ flex: 1 }}
                        segments={[
                            { text: sentence, color: settled ? theme.colors.textSecondary : status.color },
                            { text: elapsed },
                            { text: session.modelName },
                            { text: session.activitySummary },
                        ]}
                    />
                </View>
            </View>
        </Pressable>
    );

    return (
        <View style={[
            styles.sessionItemContainer,
            containerShape,
        ]}>
        {row}
        {Platform.OS === 'web' && (
            <SessionActionsPopover
                anchor={actionsAnchor}
                onClose={() => setActionsAnchor(null)}
                sessionId={session.id}
                visible={!!actionsAnchor}
            />
        )}
        </View>
    );
});
