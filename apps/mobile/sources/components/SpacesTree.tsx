import * as React from 'react';
import {
    NativeScrollEvent,
    NativeSyntheticEvent,
    Pressable,
    SectionList,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { HerdrTreePane, HerdrTreeWorkspace } from '@muxr/contract';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { agentStatusColor } from '@/utils/sessionUtils';
import { buildSpaceRows, paneDisplayName, paneTaskTitle, workspaceName, type HerdRow } from '@/utils/herdTree';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { Avatar } from './Avatar';
import { layout } from './layout';
import { useDeviceAuthority } from '@/hooks/useDeviceAuthority';

const stylesheet = StyleSheet.create((theme) => ({
    contentContainer: {
        flex: 1,
        width: '100%',
        alignSelf: 'center',
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 18,
        paddingBottom: 6,
    },
    sectionHeaderCompact: {
        paddingTop: 12,
        paddingBottom: 4,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.2,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    card: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 14,
        marginHorizontal: 12,
        marginTop: 10,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    cardCompact: {
        borderRadius: 10,
        marginHorizontal: 10,
        marginTop: 6,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        minHeight: 48,
    },
    cardHeaderCompact: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        minHeight: 44,
    },
    cardHeaderExpanded: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    cardHeaderPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    chevron: {
        width: 16,
        alignItems: 'center',
    },
    cardTitle: {
        flexShrink: 1,
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    cardTitleCompact: {
        fontSize: 14,
    },
    branchPill: {
        backgroundColor: theme.colors.surface,
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 2,
        maxWidth: 140,
    },
    branchPillText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    agentCount: {
        marginLeft: 'auto',
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    agentRow: {
        paddingHorizontal: 16,
    },
    agentRowCompact: {
        paddingHorizontal: 12,
    },
    agentPressable: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 56,
        paddingVertical: 8,
    },
    agentPressableCompact: {
        minHeight: 48,
        paddingVertical: 6,
    },
    agentPressablePressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    agentPressableSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    agentText: {
        flex: 1,
        minWidth: 0,
    },
    agentName: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    agentNameCompact: {
        fontSize: 13,
    },
    agentSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    agentSubtitleCompact: {
        fontSize: 11,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginLeft: 58,
    },
    empty: {
        paddingHorizontal: 16,
        paddingVertical: 18,
        color: theme.colors.textSecondary,
        fontSize: 13,
        ...Typography.default(),
    },
}));

interface SpacesTreeProps {
    workspaces: HerdrTreeWorkspace[];
    defaultExpandedWorkspaceIds?: readonly string[];
    refresh: () => Promise<void>;
    density?: 'comfortable' | 'compact';
    selectedSessionId?: string;
    searchQuery?: string;
    topContentInset?: number;
    bottomContentInset?: number;
    maxContentWidth?: number;
    listHeaderComponent?: React.ReactNode;
    listFooterComponent?: React.ReactNode;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    emptyText?: string;
}

const AgentRow = React.memo(({
    pane,
    first,
    onClose,
    compact,
    selected,
    canClose,
}: {
    pane: HerdrTreePane;
    first?: boolean;
    onClose: () => void;
    compact: boolean;
    selected: boolean;
    canClose: boolean;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const navigateToSession = useNavigateToSession();
    const dot = agentStatusColor(pane.agentStatus, theme);
    const kind = pane.agentKind ?? 'shell';
    const displayName = paneDisplayName(pane);
    const title = paneTaskTitle(pane);
    const sessionId = pane.sessionId;
    const subtitle = `${displayName} · ${kind}`;

    return (
        <View style={[styles.agentRow, compact && styles.agentRowCompact]}>
            {first !== true && <View style={styles.separator} />}
            <Pressable
                onPress={sessionId === undefined ? undefined : () => navigateToSession(sessionId)}
                onLongPress={canClose ? onClose : undefined}
                disabled={sessionId === undefined}
                style={({ pressed }) => [
                    styles.agentPressable,
                    compact && styles.agentPressableCompact,
                    selected && styles.agentPressableSelected,
                    pressed && styles.agentPressablePressed,
                ]}
                android_ripple={{ color: theme.colors.surfaceRipple, foreground: true }}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Open ${title}, ${displayName}`}
            >
                <Avatar id={pane.paneId} size={compact ? 28 : 32} flavor={null} />
                <View style={styles.agentText}>
                    <Text numberOfLines={1} style={[styles.agentName, compact && styles.agentNameCompact]}>{title}</Text>
                    <Text numberOfLines={1} style={[styles.agentSubtitle, compact && styles.agentSubtitleCompact]}>{subtitle}</Text>
                </View>
                <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
            </Pressable>
        </View>
    );
});

const WorkspaceCard = React.memo(({
    workspace,
    expanded,
    agentCount,
    panes,
    onToggle,
    onClose,
    onClosePane,
    compact,
    selectedSessionId,
    canClose,
}: {
    workspace: HerdrTreeWorkspace;
    expanded: boolean;
    agentCount: number;
    panes: HerdrTreePane[];
    onToggle: () => void;
    onClose: () => void;
    onClosePane: (pane: HerdrTreePane) => void;
    compact: boolean;
    selectedSessionId?: string;
    canClose: boolean;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const dot = agentStatusColor(workspace.agentStatus, theme);
    const branch = workspace.worktree?.branch;

    return (
        <View style={[styles.card, compact && styles.cardCompact]}>
            <Pressable
                onPress={onToggle}
                onLongPress={canClose ? onClose : undefined}
                style={({ pressed }) => [
                    styles.cardHeader,
                    compact && styles.cardHeaderCompact,
                    expanded && styles.cardHeaderExpanded,
                    pressed && styles.cardHeaderPressed,
                ]}
                android_ripple={{ color: theme.colors.surfaceRipple, foreground: true }}
                accessibilityRole="button"
                accessibilityLabel={`${workspaceName(workspace)} workspace, ${agentCount} agent${agentCount === 1 ? '' : 's'}`}
            >
                <View style={styles.chevron}>
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-forward'}
                        size={16}
                        color={theme.colors.groupped.chevron}
                    />
                </View>
                <StatusDot color={dot.color} isPulsing={dot.pulsing} size={8} />
                <Text numberOfLines={1} style={[styles.cardTitle, compact && styles.cardTitleCompact]}>
                    {workspaceName(workspace)}
                </Text>
                {!compact && branch !== undefined && (
                    <View style={styles.branchPill}>
                        <Text numberOfLines={1} style={styles.branchPillText}>{branch}</Text>
                    </View>
                )}
                {agentCount > 0 && (
                    <Text style={styles.agentCount}>
                        {agentCount} agent{agentCount === 1 ? '' : 's'}
                    </Text>
                )}
            </Pressable>
            {expanded && panes.map((pane, index) => (
                <AgentRow
                    key={pane.paneId}
                    pane={pane}
                    first={index === 0}
                    onClose={() => onClosePane(pane)}
                    compact={compact}
                    selected={pane.sessionId !== undefined && pane.sessionId === selectedSessionId}
                    canClose={canClose}
                />
            ))}
        </View>
    );
});

export const SpacesTree = React.memo(({
    workspaces,
    defaultExpandedWorkspaceIds = [],
    refresh,
    density = 'comfortable',
    selectedSessionId,
    searchQuery = '',
    topContentInset = 0,
    bottomContentInset = 0,
    maxContentWidth = layout.maxWidth,
    listHeaderComponent,
    listFooterComponent,
    onScroll,
    emptyText = 'No spaces open',
}: SpacesTreeProps) => {
    const styles = stylesheet;
    const compact = density === 'compact';
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const canClose = authority === 'control' && !authorityLoading;
    const seededDefaults = React.useRef(defaultExpandedWorkspaceIds.length > 0);
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
        () => new Set(defaultExpandedWorkspaceIds),
    );

    React.useEffect(() => {
        if (seededDefaults.current || defaultExpandedWorkspaceIds.length === 0) return;
        seededDefaults.current = true;
        setExpanded(new Set(defaultExpandedWorkspaceIds));
    }, [defaultExpandedWorkspaceIds]);

    const toggleWorkspace = React.useCallback((workspaceId: string) => {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(workspaceId)) next.delete(workspaceId);
            else next.add(workspaceId);
            return next;
        });
    }, []);

    const confirmCloseWorkspace = React.useCallback((workspace: HerdrTreeWorkspace) => {
        const name = workspaceName(workspace);
        Modal.alert('Close space?', `Closes "${name}" in herdr — its tabs, panes, and their processes are gone.`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Close',
                style: 'destructive',
                onPress: () => {
                    storage.getState().applyHerdrTree(
                        storage.getState().herdrWorkspaces.filter((entry) => entry.workspaceId !== workspace.workspaceId),
                    );
                    sync.request('workspace.close', { workspaceId: workspace.workspaceId })
                        .then(refresh)
                        .catch((cause) => {
                            Modal.alert('Close failed', cause instanceof Error ? cause.message : String(cause));
                            void refresh();
                        });
                },
            },
        ]);
    }, [refresh]);

    const confirmClosePane = React.useCallback((pane: HerdrTreePane) => {
        const sessionId = pane.sessionId;
        if (sessionId === undefined) return;
        const name = paneDisplayName(pane);
        Modal.alert('Close pane?', `Closes "${paneTaskTitle(pane)}" (${name}) in herdr — its process is gone.`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Close',
                style: 'destructive',
                onPress: () => {
                    storage.getState().applyHerdrTree(storage.getState().herdrWorkspaces.map((workspace) => ({
                        ...workspace,
                        tabs: workspace.tabs.map((tab) => ({
                            ...tab,
                            panes: tab.panes.filter((entry) => entry.sessionId !== sessionId),
                        })),
                    })));
                    sync.request('pane.close', { sessionId })
                        .then(refresh)
                        .catch((cause) => {
                            Modal.alert('Close failed', cause instanceof Error ? cause.message : String(cause));
                            void refresh();
                        });
                },
            },
        ]);
    }, [refresh]);

    const sections = React.useMemo(
        () => [{ key: 'spaces', title: 'spaces', data: buildSpaceRows(workspaces, expanded, searchQuery) }],
        [expanded, searchQuery, workspaces],
    );

    const renderItem = React.useCallback(({ item }: { item: HerdRow }) => (
        <WorkspaceCard
            workspace={item.workspace}
            expanded={item.expanded}
            agentCount={item.agentCount}
            panes={item.panes}
            onToggle={() => toggleWorkspace(item.workspace.workspaceId)}
            onClose={() => confirmCloseWorkspace(item.workspace)}
            onClosePane={confirmClosePane}
            compact={compact}
            selectedSessionId={selectedSessionId}
            canClose={canClose}
        />
    ), [canClose, compact, confirmClosePane, confirmCloseWorkspace, selectedSessionId, toggleWorkspace]);

    return (
        <View style={[styles.contentContainer, { maxWidth: maxContentWidth }]}>
            <SectionList
                sections={sections}
                keyExtractor={(item) => `ws-${item.workspace.workspaceId}`}
                renderItem={renderItem}
                renderSectionHeader={({ section }) => (
                    <View style={[styles.sectionHeader, compact && styles.sectionHeaderCompact]}>
                        <Text style={styles.sectionTitle}>{section.title}</Text>
                    </View>
                )}
                stickySectionHeadersEnabled={false}
                ListHeaderComponent={listHeaderComponent === undefined ? undefined : <>{listHeaderComponent}</>}
                ListFooterComponent={listFooterComponent === undefined ? undefined : <>{listFooterComponent}</>}
                ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
                onScroll={onScroll}
                scrollEventThrottle={16}
                contentContainerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            />
        </View>
    );
});
