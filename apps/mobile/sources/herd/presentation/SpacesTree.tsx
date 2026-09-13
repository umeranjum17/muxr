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
import { storage } from '@/catalog/store';
import { sync } from '@/catalog/sync';
import { useNavigateToSession } from '../application/useNavigateToSession';
import { agentStatusColor } from '../application/sessionUtils';
import { buildSpaceRows, spacesVerdict, workspaceName, type HerdRow, type SpaceGroup } from '../domain/herdTree';
import { HERD_STATUS_LABELS, agentLabels, isShellLabels, spaceRowLabels } from '../domain/agentPresentation';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { AgentGlyph } from '@/components/AgentGlyph';
import { layout } from '@/components/layout';
import { useDeviceAuthority } from '@/pairing';
import { humanError } from '@/utils/errors';

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
        flexShrink: 1,
    },
    branchPillText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    agentCount: {
        marginLeft: 'auto',
        flexShrink: 0,
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
        gap: 9,
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
        marginLeft: 43,
    },
    groupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
        minHeight: 36,
    },
    groupHeaderCompact: {
        paddingHorizontal: 12,
    },
    groupTitle: {
        fontSize: 11,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    groupCount: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    verdict: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 2,
    },
    verdictText: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
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
    tabLabel,
    first,
    onClose,
    compact,
    selected,
    canClose,
}: {
    pane: HerdrTreePane;
    tabLabel?: string;
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
    const labels = agentLabels(pane);
    const sessionId = pane.sessionId;
    const shell = isShellLabels(labels);
    const { title, subtitle } = spaceRowLabels(pane, tabLabel);

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
                accessibilityLabel={[`Open ${title}`, subtitle, shell ? undefined : HERD_STATUS_LABELS[pane.agentStatus]].filter(Boolean).join(', ')}
            >
                <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={16} />
                <View style={styles.agentText}>
                    <Text numberOfLines={1} style={[styles.agentName, compact && styles.agentNameCompact]}>{title}</Text>
                    <Text numberOfLines={1} style={[styles.agentSubtitle, compact && styles.agentSubtitleCompact]}>{subtitle}</Text>
                </View>
                <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
            </Pressable>
        </View>
    );
});

/** A state group's header: its colour, its name, its count, and a fold for the noisy ones. */
const GroupHeader = React.memo(({ group, folded, onToggle, compact }: { group: SpaceGroup; folded: boolean; onToggle: () => void; compact: boolean }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const status = group.key === 'attention' ? 'blocked' : group.key === 'working' ? 'working' : group.key === 'done' ? 'done' : 'unknown';
    const dot = agentStatusColor(status, theme);
    return (
        <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityState={{ expanded: !folded }}
            accessibilityLabel={`${group.title}, ${group.panes.length}`}
            style={[styles.groupHeader, compact && styles.groupHeaderCompact]}
        >
            <StatusDot color={dot.color} isPulsing={false} size={7} />
            <Text style={styles.groupTitle}>{group.title}</Text>
            <Text style={styles.groupCount}>({group.panes.length})</Text>
            <View style={{ marginLeft: 'auto' }}>
                <Ionicons name={folded ? 'chevron-forward' : 'chevron-down'} size={14} color={theme.colors.groupped.chevron} />
            </View>
        </Pressable>
    );
});

const WorkspaceCard = React.memo(({
    workspace,
    expanded,
    agentCount,
    groups,
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
    groups: SpaceGroup[];
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
    // Folds are per group and remembered while the card lives; the noisy
    // groups start folded, the attention group never folds.
    const [unfolded, setUnfolded] = React.useState<ReadonlySet<string>>(() => new Set());
    const toggleGroup = React.useCallback((key: string) => setUnfolded((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    }), []);

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
                accessibilityLabel={`${workspaceName(workspace)} workspace, ${agentCount} agent${agentCount === 1 ? '' : 's'}, ${HERD_STATUS_LABELS[workspace.agentStatus]}`}
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
                {/* The narrow sidebar keeps the name and the count; the branch pill
                    would only push the name into an ellipsis there. */}
                {branch !== undefined && !compact && (
                    <View style={styles.branchPill}>
                        <Text numberOfLines={1} style={styles.branchPillText}>{branch}</Text>
                    </View>
                )}
                {agentCount > 0 && (
                    <Text numberOfLines={1} style={styles.agentCount}>
                        {agentCount} agent{agentCount === 1 ? '' : 's'}
                    </Text>
                )}
            </Pressable>
            {expanded && groups.map((group) => {
                const folded = group.foldedByDefault !== unfolded.has(group.key);
                return (
                    <React.Fragment key={group.key}>
                        <GroupHeader group={group} folded={folded} onToggle={() => toggleGroup(group.key)} compact={compact} />
                        {!folded && group.panes.map(({ pane, tabLabel }, index) => (
                            <AgentRow
                                key={pane.paneId}
                                pane={pane}
                                tabLabel={tabLabel}
                                first={index === 0}
                                onClose={() => onClosePane(pane)}
                                compact={compact}
                                selected={pane.sessionId !== undefined && pane.sessionId === selectedSessionId}
                                canClose={canClose}
                            />
                        ))}
                    </React.Fragment>
                );
            })}
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
        Modal.alert('Close workspace?', `Closes only the "${name}" workspace in herdr. If that would close its worktree group, nothing closes.`, [
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
                            Modal.alert('Close failed', humanError(cause).message);
                            void refresh();
                        });
                },
            },
        ]);
    }, [refresh]);

    const confirmClosePane = React.useCallback((pane: HerdrTreePane) => {
        const sessionId = pane.sessionId;
        if (sessionId === undefined) return;
        const labels = agentLabels(pane);
        const identity = ` (${labels.agentName})`;
        Modal.alert('Close pane?', `Closes only the pane for "${labels.taskTitle}"${identity} in herdr. If that would also close its tab, nothing closes.`, [
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
                            Modal.alert('Close failed', humanError(cause).message);
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
    // The list answers "do I need to act" before any row is read. Blocked
    // agents are the ones that get missed, so they lead the line and its
    // colour; failed ones are named next; a quiet list says so.
    const verdict = React.useMemo(() => spacesVerdict(workspaces), [workspaces]);
    const { theme } = useUnistyles();
    const attention = verdict.blocked > 0 || verdict.failed > 0;
    const verdictColor = attention ? theme.colors.status.error : theme.colors.status.done;

    const renderItem = React.useCallback(({ item }: { item: HerdRow }) => (
        <WorkspaceCard
            workspace={item.workspace}
            expanded={item.expanded}
            agentCount={item.agentCount}
            groups={item.groups}
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
                    <>
                        <View style={[styles.sectionHeader, compact && styles.sectionHeaderCompact]}>
                            <Text accessibilityRole="header" aria-level={2} style={styles.sectionTitle}>{section.title}</Text>
                        </View>
                        {workspaces.length > 0 && (
                            <View style={styles.verdict} accessibilityLiveRegion="polite">
                                <Ionicons name={attention ? 'alert-circle' : 'checkmark'} size={18} color={verdictColor} />
                                <Text style={[styles.verdictText, attention && { color: verdictColor }]}>{verdict.text}</Text>
                            </View>
                        )}
                    </>
                )}
                stickySectionHeadersEnabled={false}
                ListHeaderComponent={listHeaderComponent === undefined ? undefined : <>{listHeaderComponent}</>}
                ListFooterComponent={listFooterComponent === undefined ? undefined : <>{listFooterComponent}</>}
                ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
                onScroll={onScroll}
                scrollEventThrottle={100}
                contentContainerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            />
        </View>
    );
});
