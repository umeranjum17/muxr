import React from 'react';
import { View, Pressable, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, SessionRowData } from '@/sync/storage';
import { formatLastSeen, sessionStateColors, unreadStateColors, vibingMessages } from '@/utils/sessionUtils';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { isSettledSession, SESSION_GLYPH_COLUMN, SessionMetaLine, SessionStateGlyph } from './SessionRowParts';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { LiveTerminalsRow } from './LiveTerminalsRow';
import { layout } from './layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { t } from '@/text';
import { SessionShortcutHintBadge } from './ShortcutHints';
import { ProviderIcon } from './ProviderIcon';

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
        minHeight: 60,
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
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
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    sessionTitle: {
        fontSize: 15,
        lineHeight: 20,
        letterSpacing: -0.1,
        flex: 1,
        ...Typography.default(),
    },
    sessionShortcutBadge: {
        flexShrink: 0,
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionMetaLine: {
        marginLeft: SESSION_GLYPH_COLUMN,
        marginTop: 1,
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
    const isTablet = useIsTablet();
    // Selection is derived once from pathname so the data array stays stable
    // across navigations. This keeps FlatList virtualization intact: only
    // the previously- and newly-selected rows re-render, instead of the
    // whole visible window.
    const selectedSessionId = React.useMemo<string | undefined>(() => {
        if (!isTablet) return undefined;
        if (!pathname.startsWith('/session/')) return undefined;
        return pathname.split('/')[2];
    }, [isTablet, pathname]);

    // Request review
    React.useEffect(() => {
        if (sourceData && sourceData.length > 0) {
            requestReview();
        }
    }, [sourceData && sourceData.length > 0]);

    const data = React.useMemo(() => {
        const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
        if (!sourceData || !normalizedQuery) {
            return sourceData;
        }

        const matches = (session: SessionRowData) => [
            session.name,
            session.subtitle,
            session.path,
            session.machineId,
            session.flavor,
        ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));

        const keepIndices = new Set<number>();
        let currentHeaderIndex: number | null = null;

        sourceData.forEach((item, index) => {
            if (item.type === 'header') {
                currentHeaderIndex = index;
                return;
            }
            if (item.type === 'session' && matches(item.session)) {
                keepIndices.add(index);
                if (currentHeaderIndex !== null) keepIndices.add(currentHeaderIndex);
            }
        });

        const result: SessionListViewItem[] = [];
        sourceData.forEach((item, index) => {
            if (item.type === 'active-sessions') {
                const sessions = item.sessions.filter(matches);
                if (sessions.length > 0) result.push({ ...item, sessions });
                return;
            }
            if (keepIndices.has(index)) result.push(item);
        });
        return result;
    }, [searchQuery, sourceData]);

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
                    />
                );
        }
    }, [selectedSessionId, data]);


    // Remove this section as we'll use FlatList for all items now


    const HeaderComponent = React.useCallback(() => {
        return (
            <>
                <LiveTerminalsRow />
                <UpdateBanner />
            </>
        );
    }, []);

    // Footer removed - all sessions now shown inline

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={data}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    extraData={selectedSessionId}
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

export const SessionItem = React.memo(({ session, selected, isFirst, isLast, isSingle }: {
    session: SessionRowData;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
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

    const statusText = session.hasUnread
        ? t('status.unread')
        : session.state === 'thinking'
            ? vibingMessage
            : session.state === 'disconnected'
                ? t('status.lastSeen', { time: formatLastSeen(session.activeAt!, false) })
                : session.state === 'permission_required'
                    ? t('status.permissionRequired')
                    : t('status.online');

    // Screen readers get the facts only — the random 'vibing' message would
    // announce differently on every render.
    const factualStatus = session.hasUnread
        ? t('status.unread')
        : session.state === 'disconnected'
            ? t('status.lastSeen', { time: formatLastSeen(session.activeAt!, false) })
            : session.state === 'permission_required'
                ? t('status.permissionRequired')
                : t('status.online');

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

    const row = (
        <Pressable
            style={({ pressed }) => [
                styles.sessionItem,
                { opacity: pressed ? 0.55 : settled ? 0.75 : 1 },
                selected && styles.sessionItemSelected,
                isSingle ? styles.sessionItemSingle :
                    isFirst ? styles.sessionItemFirst :
                        isLast ? styles.sessionItemLast : {}
            ]}
            onPress={handlePress}
            accessibilityRole="button"
            accessibilityState={{ selected: !!selected }}
            accessibilityLabel={`${session.name}, ${factualStatus}`}
            {...menuProps}
        >
            <View style={styles.sessionTitleRow}>
                <SessionStateGlyph session={session} status={status} />
                <Text style={[
                    styles.sessionTitle,
                    status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                ]} numberOfLines={1}>
                    {session.name}
                </Text>
                {/* The provider mark rides the title's trailing edge: in the
                    metadata line it would push the text off the one left grid
                    every row shares. */}
                <ProviderIcon kind={session.providerKind} size={12} monochrome />
                <SessionShortcutHintBadge
                    sessionId={session.id}
                    style={styles.sessionShortcutBadge}
                />
            </View>

            {/* Verb first, then where it happened: settled rows spend no
                colour, so the eye lands on the one still working. */}
            <SessionMetaLine
                style={styles.sessionMetaLine}
                segments={[
                    { text: statusText, color: settled ? theme.colors.textSecondary : status.color },
                    { text: session.modelName },
                    { text: session.path?.split(/[/\\]/).filter(Boolean).pop() ?? session.subtitle },
                    { text: session.activitySummary },
                ]}
            />
        </Pressable>
    );

    return (
        <View style={[
            styles.sessionItemContainer,
            isSingle ? styles.sessionItemContainerSingle :
                isFirst ? styles.sessionItemContainerFirst :
                    isLast ? styles.sessionItemContainerLast : {}
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
