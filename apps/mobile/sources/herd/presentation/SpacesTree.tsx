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
import { buildSpaceRows, workspaceName, type HerdRow } from '../domain/herdTree';
import { agentIdentityLine, agentLabels, isShellLabels } from '../domain/agentPresentation';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { SectionLabel } from '@/components/ui';
import { t } from '@/text';
import { AgentGlyph } from '@/components/AgentGlyph';
import { layout } from '@/components/layout';
import { useDeviceAuthority } from '@/pairing';

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
        paddingTop: 20,
        paddingBottom: 8,
    },
    sectionHeaderCompact: {
        paddingTop: 12,
        paddingBottom: 4,
    },
    card: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        marginHorizontal: 16,
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
        borderRadius: 999,
        paddingHorizontal: 6,
        paddingVertical: 2,
        maxWidth: 140,
    },
    branchPillText: {
        fontSize: 10,
        lineHeight: 13,
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    agentCount: {
        marginLeft: 'auto',
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default(),
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
        marginLeft: 44,
    },
    empty: {
        paddingHorizontal: 16,
        paddingVertical: 18,
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default(),
    },
}));

interface SpacesTreeProps {
    workspaces: HerdrTreeWorkspace[];
    defaultExpandedWorkspaceIds?: readonly string[];
    refresh: () => Promise<void>;
    density?: 'comfortable' | 'compact';
    selectedSessionId?: string;
    /** Override pane navigation (a sheet closes itself, then navigates). */
    onNavigatePane?: (sessionId: string) => void;
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
    onNavigatePane,
    compact,
    selected,
    canClose,
}: {
    pane: HerdrTreePane;
    first?: boolean;
    onClose: () => void;
    onNavigatePane?: (sessionId: string) => void;
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
    const title = labels.taskTitle;
    const subtitle = agentIdentityLine(labels);

    return (
        <View style={[styles.agentRow, compact && styles.agentRowCompact]}>
            {first !== true && <View style={styles.separator} />}
            <Pressable
                onPress={sessionId === undefined ? undefined : () => (onNavigatePane ?? navigateToSession)(sessionId)}
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
                accessibilityLabel={[`Open ${title}`, subtitle].filter(Boolean).join(', ')}
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

const WorkspaceCard = React.memo(({
    workspace,
    expanded,
    agentCount,
    panes,
    onToggle,
    onClose,
    onClosePane,
    onNavigatePane,
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
    onNavigatePane?: (sessionId: string) => void;
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
                {branch !== undefined && (
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
                    onNavigatePane={onNavigatePane}
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
    onNavigatePane,
    searchQuery = '',
    topContentInset = 0,
    bottomContentInset = 0,
    maxContentWidth = layout.maxWidth,
    listHeaderComponent,
    listFooterComponent,
    onScroll,
    emptyText,
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
                            Modal.alert('Close failed', cause instanceof Error ? cause.message : String(cause));
                            void refresh();
                        });
                },
            },
        ]);
    }, [refresh]);

    const sections = React.useMemo(
        () => [{ key: 'spaces', title: t('spacesTree.title'), data: buildSpaceRows(workspaces, expanded, searchQuery) }],
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
            onNavigatePane={onNavigatePane}
            compact={compact}
            selectedSessionId={selectedSessionId}
            canClose={canClose}
        />
    ), [canClose, compact, confirmClosePane, confirmCloseWorkspace, onNavigatePane, selectedSessionId, toggleWorkspace]);

    return (
        <View style={[styles.contentContainer, { maxWidth: maxContentWidth }]}>
            <SectionList
                sections={sections}
                keyExtractor={(item) => `ws-${item.workspace.workspaceId}`}
                renderItem={renderItem}
                renderSectionHeader={({ section }) => (
                    <View style={[styles.sectionHeader, compact && styles.sectionHeaderCompact]}>
                        <SectionLabel>{section.title}</SectionLabel>
                    </View>
                )}
                stickySectionHeadersEnabled={false}
                ListHeaderComponent={listHeaderComponent === undefined ? undefined : <>{listHeaderComponent}</>}
                ListFooterComponent={<>
                    {(sections[0]?.data.length ?? 0) === 0 ? <Text style={styles.empty}>{emptyText ?? t('spacesTree.empty')}</Text> : null}
                    {listFooterComponent === undefined ? undefined : <>{listFooterComponent}</>}
                </>}
                onScroll={onScroll}
                scrollEventThrottle={100}
                contentContainerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            />
        </View>
    );
});
