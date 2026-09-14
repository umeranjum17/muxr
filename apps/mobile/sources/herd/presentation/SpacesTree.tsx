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
import { storage, useLocalSetting } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { useNavigateToSession } from '../application/useNavigateToSession';
import { agentStatusColor } from '../application/sessionUtils';
import { buildSpaceRows, middleTruncate, spaceSummary, workspaceName, type HerdRow, type HerdWorktreeRow, type SpaceCounts } from '../domain/herdTree';
import { agentLabels, agentStateLabel, isGenericLaunchTitle, isShellLabels } from '../domain/agentPresentation';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
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
        paddingTop: 18,
        paddingBottom: 6,
    },
    sectionHeaderCompact: {
        paddingTop: 12,
        paddingBottom: 4,
    },
    sectionTitle: {
        fontSize: 14,
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
        minHeight: 54,
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
    headerText: { flex: 1, minWidth: 0 },
    summary: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary, marginTop: 2, ...Typography.default() },
    pathHint: { fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary, ...Typography.default() },
    repoHeading: { marginHorizontal: 16, marginTop: 16, marginBottom: 2 },
    repoHeadingCompact: { marginHorizontal: 12, marginTop: 12 },
    repoTitle: { fontSize: 16, lineHeight: 20, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') },
    repoSummary: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary, marginTop: 2, ...Typography.default() },
    childSelected: { backgroundColor: theme.colors.surfaceSelected },
    workspaceSubheader: {
        flexDirection: 'row', alignItems: 'center', minHeight: 44,
        paddingLeft: 32, paddingRight: 12,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider,
    },
    workspaceSubheaderText: { flex: 1, fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() },
    shellDisclosure: {
        flexDirection: 'row', alignItems: 'center', minHeight: 44,
        paddingLeft: 32, paddingRight: 16,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider,
    },
    shellDisclosureText: { flex: 1, fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() },
    closeSpace: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
    cardHeaderPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    chevron: {
        width: 16,
        alignItems: 'center',
    },
    cardTitle: {
        flexShrink: 1,
        fontSize: 16,
        lineHeight: 20,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    cardTitleCompact: {
        fontSize: 15,
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
        fontSize: 15,
        lineHeight: 20,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    agentNameCompact: {
        fontSize: 14,
    },
    agentSubtitle: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    agentSubtitleCompact: {
        fontSize: 12,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginLeft: 43,
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
    const labels = agentLabels(pane);
    const sessionId = pane.sessionId;
    const shell = isShellLabels(labels);
    const identity = shell ? 'Shell' : labels.agentKind && labels.agentName !== 'Unnamed agent'
        ? `${labels.agentKind}/${labels.agentName}` : labels.agentName;
    const genericTitle = isGenericLaunchTitle(labels.taskTitle);
    const task = genericTitle || labels.taskTitle === labels.agentName || shell ? '' : labels.taskTitle;
    const cwdName = pane.cwd?.replace(/\/+$/, '').split('/').pop();
    const subtitle = [agentStateLabel(pane.agentStatus, pane.changedAt), shell ? cwdName : task].filter(Boolean).join(' · ');

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
                accessibilityLabel={[`Open ${identity}`, subtitle].filter(Boolean).join(', ')}
            >
                <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={16} />
                <View style={styles.agentText}>
                    <Text numberOfLines={1} style={[styles.agentName, compact && styles.agentNameCompact]}>{identity}</Text>
                    <Text numberOfLines={1} style={[styles.agentSubtitle, compact && styles.agentSubtitleCompact]}>{subtitle}</Text>
                </View>
                <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
            </Pressable>
        </View>
    );
});

function statusForCounts(counts: SpaceCounts): HerdrTreePane['agentStatus'] {
    if (counts.blocked) return 'blocked';
    if (counts.failed) return 'failed';
    if (counts.working) return 'working';
    if (counts.starting) return 'starting';
    if (counts.done) return 'done';
    return 'unknown';
}

const WorktreeChild = React.memo(({
    row, compact, searchActive, selectedSessionId, shellExpanded, canClose, onToggle, onCloseWorkspace, onClosePane,
}: {
    row: HerdWorktreeRow;
    compact: boolean;
    searchActive: boolean;
    selectedSessionId?: string;
    shellExpanded: boolean;
    canClose: boolean;
    onToggle: (key: string) => void;
    onCloseWorkspace: (workspace: HerdrTreeWorkspace) => void;
    onClosePane: (pane: HerdrTreePane) => void;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const dot = agentStatusColor(statusForCounts(row.counts), theme);
    const branch = row.branch !== row.title ? row.branch : undefined;
    const workspaceGroups = row.workspaces.map((workspace) => ({
        workspace,
        panes: row.panes.filter((entry) => entry.workspace.workspaceId === workspace.workspaceId),
    })).filter((group) => !searchActive || group.panes.length > 0)
        .sort((left, right) => row.panes.findIndex((entry) => entry.workspace.workspaceId === left.workspace.workspaceId)
            - row.panes.findIndex((entry) => entry.workspace.workspaceId === right.workspace.workspaceId));
    const agentGroups = workspaceGroups.map((group) => ({ ...group, panes: group.panes.filter(({ pane }) => pane.agentKind !== undefined) }))
        .filter((group) => group.panes.length > 0);
    const shellGroups = workspaceGroups.map((group) => ({ ...group, panes: group.panes.filter(({ pane }) => pane.agentKind === undefined) }))
        .filter((group) => group.panes.length > 0);
    const selectedShell = selectedSessionId !== undefined && row.workspaces.some((workspace) => workspace.tabs.some((tab) =>
        tab.panes.some((pane) => pane.sessionId === selectedSessionId && pane.agentKind === undefined)));
    const groupShells = !searchActive && agentGroups.length > 0 && shellGroups.length > 0;
    const showShells = !groupShells || shellExpanded || selectedShell;
    const renderGroups = (groups: typeof workspaceGroups) => groups.map(({ workspace, panes }) => <React.Fragment key={workspace.workspaceId}>
        {row.workspaces.length > 1 && <View style={styles.workspaceSubheader}>
            <Text numberOfLines={1} style={styles.workspaceSubheaderText}>{workspaceName(workspace)}</Text>
            {canClose && <Pressable onPress={() => onCloseWorkspace(workspace)} style={styles.closeSpace} accessibilityRole="button" accessibilityLabel={`Close ${workspaceName(workspace)} workspace`}>
                <Ionicons name="close-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>}
        </View>}
        {panes.map(({ pane }, index) => <AgentRow key={pane.paneId} pane={pane} first={index === 0} onClose={() => onClosePane(pane)} compact={compact}
            selected={pane.sessionId !== undefined && pane.sessionId === selectedSessionId} canClose={canClose} />)}
    </React.Fragment>);
    return <>
        <Pressable
            onPress={searchActive ? undefined : () => onToggle(row.key)}
            onLongPress={canClose && row.workspaces.length === 1 ? () => onCloseWorkspace(row.workspaces[0]!) : undefined}
            style={({ pressed }) => [styles.cardHeader, compact && styles.cardHeaderCompact, row.expanded && styles.cardHeaderExpanded, row.selected && styles.childSelected, pressed && styles.cardHeaderPressed]}
            accessibilityRole="button"
            accessibilityState={{ expanded: row.expanded, selected: row.selected }}
            accessibilityLabel={`${row.title}, worktree, ${spaceSummary(row.counts)}, ${row.expanded ? 'expanded' : 'collapsed'}`}
        >
            <View style={styles.chevron}><Ionicons name={row.expanded ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.groupped.chevron} /></View>
            <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
            <View style={styles.headerText}>
                <Text numberOfLines={1} style={[styles.cardTitle, compact && styles.cardTitleCompact]}>{row.title}</Text>
                {branch && <Text numberOfLines={1} style={styles.pathHint}>{branch}</Text>}
                {row.title === 'Detached worktree' && <Text numberOfLines={1} style={styles.pathHint}>{middleTruncate(row.path, 36)}</Text>}
                <Text numberOfLines={2} style={styles.summary}>{spaceSummary(row.counts)}</Text>
            </View>
        </Pressable>
        {row.expanded && renderGroups(agentGroups)}
        {row.expanded && groupShells && <Pressable onPress={() => onToggle(shellDisclosureKey(row.key))}
            style={({ pressed }) => [styles.shellDisclosure, pressed && styles.cardHeaderPressed]}
            accessibilityRole="button" accessibilityState={{ expanded: showShells }}
            accessibilityLabel={`${row.counts.shells} shell${row.counts.shells === 1 ? '' : 's'}, ${showShells ? 'expanded' : 'collapsed'}`}>
            <Text style={styles.shellDisclosureText}>{row.counts.shells} shell{row.counts.shells === 1 ? '' : 's'}</Text>
            <Ionicons name={showShells ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.groupped.chevron} />
        </Pressable>}
        {row.expanded && showShells && renderGroups(shellGroups)}
    </>;
});

const shellDisclosureKey = (checkoutKey: string) => `shells:${checkoutKey}`;

function initialDisclosure(workspaces: readonly HerdrTreeWorkspace[], selectedSessionId?: string): Set<string> {
    const rows = buildSpaceRows(workspaces, new Set(), '', selectedSessionId);
    const open = new Set<string>();
    for (const row of rows) {
        if (row.type === 'repository') {
            for (const child of row.worktrees) {
                if (child.selected || child.counts.blocked || child.counts.failed || child.counts.working || child.counts.starting) {
                    open.add(child.key);
                }
            }
        } else if (row.selected || row.counts.blocked || row.counts.failed || row.counts.working || row.counts.starting) {
            open.add(`workspace:${row.workspace.workspaceId}`);
        }
    }
    return open;
}

function disclosureWithPreferences(workspaces: readonly HerdrTreeWorkspace[], selectedSessionId: string | undefined, preferences: readonly string[] | undefined): Set<string> {
    const open = initialDisclosure(workspaces, selectedSessionId);
    for (const preference of preferences ?? []) {
        if (preference.startsWith('+')) open.add(preference.slice(1));
        if (preference.startsWith('-')) open.delete(preference.slice(1));
    }
    if (selectedSessionId !== undefined) {
        for (const row of buildSpaceRows(workspaces, new Set(), '', selectedSessionId)) {
            if (row.type === 'repository') {
                for (const child of row.worktrees) if (child.selected) open.add(child.key);
            } else if (row.selected) open.add(`workspace:${row.workspace.workspaceId}`);
        }
    }
    return open;
}

export const SpacesTree = React.memo(({
    workspaces, refresh, density = 'comfortable', selectedSessionId, searchQuery = '',
    topContentInset = 0, bottomContentInset = 0, maxContentWidth = layout.maxWidth,
    listHeaderComponent, listFooterComponent, onScroll, emptyText = 'No spaces open',
}: SpacesTreeProps) => {
    const styles = stylesheet;
    const compact = density === 'compact';
    const { theme } = useUnistyles();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const canClose = authority === 'control' && !authorityLoading;
    const machineId = getCachedConnectionSettings().machineId;
    const savedDisclosure = useLocalSetting('herdTreeDisclosure');
    const savedKeys = savedDisclosure[machineId];
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
        () => disclosureWithPreferences(workspaces, selectedSessionId, savedKeys),
    );

    React.useEffect(() => {
        const next = disclosureWithPreferences(workspaces, selectedSessionId, savedKeys);
        setExpanded((previous) => previous.size === next.size && [...previous].every((key) => next.has(key)) ? previous : next);
    }, [machineId, workspaces, selectedSessionId, savedKeys]);

    const toggle = React.useCallback((key: string) => {
        const next = new Set(expanded);
        if (next.has(key)) next.delete(key); else next.add(key);
        setExpanded(next);
        if (!machineId) return;
        const valid = new Set<string>();
        for (const row of buildSpaceRows(workspaces, new Set(), '')) {
            if (row.type === 'repository') {
                for (const child of row.worktrees) {
                    valid.add(child.key);
                    if (child.counts.agents && child.counts.shells) valid.add(shellDisclosureKey(child.key));
                }
            } else valid.add(`workspace:${row.workspace.workspaceId}`);
        }
        const preferences = new Map((savedKeys ?? []).filter((entry) => entry.length > 1).map((entry) => [entry.slice(1), entry[0]]));
        preferences.set(key, next.has(key) ? '+' : '-');
        storage.getState().applyLocalSettings({
            herdTreeDisclosure: { ...savedDisclosure, [machineId]: [...preferences].filter(([entry]) => valid.has(entry)).map(([entry, sign]) => `${sign}${entry}`) },
        });
    }, [expanded, machineId, savedDisclosure, savedKeys, workspaces]);

    const confirmCloseWorkspace = React.useCallback((workspace: HerdrTreeWorkspace) => {
        const name = workspaceName(workspace);
        Modal.alert('Close workspace?', `Closes only the "${name}" workspace in herdr. If that would close its worktree group, nothing closes.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Close', style: 'destructive', onPress: () => {
                storage.getState().applyHerdrTree(storage.getState().herdrWorkspaces.filter((entry) => entry.workspaceId !== workspace.workspaceId));
                sync.request('workspace.close', { workspaceId: workspace.workspaceId }).then(refresh).catch((cause) => {
                    Modal.alert('Close failed', cause instanceof Error ? cause.message : String(cause));
                    void refresh();
                });
            } },
        ]);
    }, [refresh]);

    const confirmClosePane = React.useCallback((pane: HerdrTreePane) => {
        const sessionId = pane.sessionId;
        if (sessionId === undefined) return;
        const labels = agentLabels(pane);
        Modal.alert('Close pane?', `Closes only the pane for "${labels.taskTitle}" (${labels.agentName}) in herdr. If that would also close its tab, nothing closes.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Close', style: 'destructive', onPress: () => {
                storage.getState().applyHerdrTree(storage.getState().herdrWorkspaces.map((workspace) => ({
                    ...workspace, tabs: workspace.tabs.map((tab) => ({ ...tab, panes: tab.panes.filter((entry) => entry.sessionId !== sessionId) })),
                })));
                sync.request('pane.close', { sessionId }).then(refresh).catch((cause) => {
                    Modal.alert('Close failed', cause instanceof Error ? cause.message : String(cause));
                    void refresh();
                });
            } },
        ]);
    }, [refresh]);

    const rows = React.useMemo(() => buildSpaceRows(workspaces, expanded, searchQuery, selectedSessionId), [expanded, searchQuery, selectedSessionId, workspaces]);
    const repositories = rows.filter((row) => row.type === 'repository');
    const other = rows.filter((row) => row.type === 'workspace');
    const sections = [
        ...(repositories.length ? [{ key: 'repositories', title: 'Repositories', data: repositories }] : []),
        ...(other.length ? [{ key: 'other', title: 'Other spaces', data: other }] : []),
    ];
    const searchActive = searchQuery.trim() !== '';

    const renderItem = ({ item }: { item: HerdRow }) => {
        if (item.type === 'workspace') {
            const dot = agentStatusColor(statusForCounts(item.counts), theme);
            const name = workspaceName(item.workspace);
            const pathHint = name === 'Untitled space' ? item.workspace.tabs.flatMap((tab) => tab.panes).find((pane) => pane.cwd)?.cwd : undefined;
            return <View style={[styles.card, compact && styles.cardCompact]}>
                <Pressable onPress={searchActive ? undefined : () => toggle(`workspace:${item.workspace.workspaceId}`)}
                    onLongPress={canClose ? () => confirmCloseWorkspace(item.workspace) : undefined}
                    style={({ pressed }) => [styles.cardHeader, compact && styles.cardHeaderCompact, item.expanded && styles.cardHeaderExpanded, item.selected && styles.childSelected, pressed && styles.cardHeaderPressed]}
                    accessibilityRole="button" accessibilityState={{ expanded: item.expanded, selected: item.selected }}
                    accessibilityLabel={`${name}, workspace, ${spaceSummary(item.counts)}, ${item.expanded ? 'expanded' : 'collapsed'}`}>
                    <View style={styles.chevron}><Ionicons name={item.expanded ? 'chevron-down' : 'chevron-forward'} size={16} color={theme.colors.groupped.chevron} /></View>
                    <StatusDot color={dot.color} isPulsing={dot.pulsing} size={8} />
                    <View style={styles.headerText}>
                        <Text numberOfLines={1} style={[styles.cardTitle, compact && styles.cardTitleCompact]}>{name}</Text>
                        <Text numberOfLines={1} style={styles.summary}>{pathHint ?? spaceSummary(item.counts)}</Text>
                    </View>
                </Pressable>
                {item.expanded && item.panes.map(({ pane }, index) => <AgentRow key={pane.paneId} pane={pane} first={index === 0}
                    onClose={() => confirmClosePane(pane)} compact={compact}
                    selected={pane.sessionId !== undefined && pane.sessionId === selectedSessionId} canClose={canClose} />)}
            </View>;
        }
        const visibleCount = item.worktrees.length;
        const filtered = searchActive && visibleCount !== item.totalWorktrees ? ` · ${visibleCount} shown` : '';
        return <View>
            <View style={[styles.repoHeading, compact && styles.repoHeadingCompact]} accessibilityLabel={`${item.title}, repository, ${spaceSummary(item.counts, item.totalWorktrees)}`}>
                <Text numberOfLines={1} style={styles.repoTitle}>{item.title}</Text>
                {item.pathHint && <Text numberOfLines={1} style={styles.pathHint}>{middleTruncate(item.pathHint, 36)}</Text>}
                <Text numberOfLines={2} style={styles.repoSummary}>{spaceSummary(item.counts, item.totalWorktrees)}{filtered}</Text>
            </View>
            {item.worktrees.map((child) => <View key={child.key} style={[styles.card, compact && styles.cardCompact]}><WorktreeChild row={child} compact={compact}
                searchActive={searchActive} selectedSessionId={selectedSessionId} shellExpanded={expanded.has(shellDisclosureKey(child.key))}
                canClose={canClose} onToggle={toggle}
                onCloseWorkspace={confirmCloseWorkspace} onClosePane={confirmClosePane} /></View>)}
        </View>;
    };

    return <View style={[styles.contentContainer, { maxWidth: maxContentWidth }]}>
        <SectionList sections={sections} keyExtractor={(item) => item.type === 'repository' ? item.key : item.workspace.workspaceId}
            renderItem={renderItem} renderSectionHeader={({ section }) => <View style={[styles.sectionHeader, compact && styles.sectionHeaderCompact]}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>}
            stickySectionHeadersEnabled={false}
            ListHeaderComponent={listHeaderComponent === undefined ? undefined : <>{listHeaderComponent}</>}
            ListFooterComponent={listFooterComponent === undefined ? undefined : <>{listFooterComponent}</>}
            ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
            onScroll={onScroll} scrollEventThrottle={100}
            contentContainerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }} />
    </View>;
});
