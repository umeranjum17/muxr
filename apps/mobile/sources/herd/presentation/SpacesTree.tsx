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
import { useUnseenDoneSessionIds } from '../application/useActivityAcknowledgements';
import { buildSpaceRows, groupKind, groupSummaryCounts, workspaceName, type HerdChildSpace, type HerdSpaceRow } from '../domain/herdTree';
import { agentIdentityLine, agentLabels, agentNameLine, agentStateLabel, isShellLabels } from '../domain/agentPresentation';
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
    agentNameQuiet: {
        color: theme.colors.textSecondary,
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
    groupRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        minHeight: 48,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    groupRowPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    groupTitleSlot: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    groupTitle: {
        flexShrink: 1,
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default(),
    },
    groupSummaryProbe: {
        position: 'absolute',
        top: -1000,
        left: 0,
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        opacity: 0,
    },
    chipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: theme.colors.surface,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingHorizontal: 7,
        paddingVertical: 2,
    },
    chipText: {
        fontSize: 10,
        lineHeight: 13,
        ...Typography.mono(),
    },
    railOverlay: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 28,
    },
    railLine: {
        position: 'absolute',
        left: 17,
        top: 0,
        bottom: 0,
        width: 2,
        backgroundColor: theme.colors.groupped.rail,
    },
    railElbow: {
        position: 'absolute',
        left: 17,
        top: 0,
        width: 15,
        height: '50%',
        borderLeftWidth: 2,
        borderBottomWidth: 2,
        borderBottomLeftRadius: 10,
        borderColor: theme.colors.groupped.rail,
    },
    childRow: {
        paddingLeft: 28,
        paddingRight: 16,
    },
    childAgentInset: {
        paddingLeft: 28,
    },
    childSeparator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginLeft: 48,
    },
    childPressable: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingVertical: 8,
    },
    childPressablePressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    childPressableSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    childText: {
        flex: 1,
        minWidth: 0,
    },
    childLabel: {
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default(),
    },
    childLine2: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    skeleton: {
        height: 120,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        opacity: 0.6,
        marginHorizontal: 16,
        marginTop: 10,
    },
}));

interface SpacesTreeProps {
    workspaces: HerdrTreeWorkspace[];
    defaultExpandedWorkspaceIds?: readonly string[];
    refresh: () => Promise<void>;
    density?: 'comfortable' | 'compact';
    selectedSessionId?: string;
    /** First tree not answered yet: one skeleton card, no spinner. */
    loading?: boolean;
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
    unseenDone,
}: {
    pane: HerdrTreePane;
    first?: boolean;
    onClose: () => void;
    onNavigatePane?: (sessionId: string) => void;
    compact: boolean;
    selected: boolean;
    canClose: boolean;
    unseenDone: boolean;
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
    // One weight rule: bright means "has something for you". A finished
    // outcome you have not opened stays loud; settled-and-seen goes quiet.
    const quiet = (pane.agentStatus === 'done' || pane.agentStatus === 'idle') && !unseenDone;

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
                accessibilityLabel={[`Open ${title}`, unseenDone ? 'new result' : undefined, subtitle].filter(Boolean).join(', ')}
            >
                <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={16} />
                <View style={styles.agentText}>
                    <Text numberOfLines={1} style={[styles.agentName, compact && styles.agentNameCompact, quiet && styles.agentNameQuiet]}>{title}</Text>
                    <Text numberOfLines={1} style={[styles.agentSubtitle, compact && styles.agentSubtitleCompact]}>{subtitle}</Text>
                </View>
                <StatusDot color={quiet ? theme.colors.status.disconnected : dot.color} isPulsing={dot.pulsing} size={7} />
            </Pressable>
        </View>
    );
});

/**
 * A child's second line, in parts: its one agent's identity and state, else a
 * count, else what it is. Rendered with ' · ', spoken with ', '.
 */
function childLine2Parts(child: HerdChildSpace): string[] {
    const panes = child.workspace.tabs.flatMap((tab) => tab.panes);
    const agentPanes = panes.filter((pane) => pane.agentKind !== undefined);
    if (panes.length === 0) return [t('spacesTree.childEmpty')];
    if (agentPanes.length === 0) return [t('spacesTree.shell')];
    if (agentPanes.length > 1) return [t('spacesTree.childAgents', { count: agentPanes.length })];
    const agent = agentPanes[0];
    if (agent === undefined) return [t('spacesTree.childEmpty')];
    return [agentNameLine(agentLabels(agent)), agentStateLabel(agent.agentStatus)];
}

/** A group-row status pill: colored dot + mono count, visual only (row label speaks it). */
const Chip = React.memo(({ count, word, color }: { count: number; word?: string; color: string }) => (
    <View style={stylesheet.chip} pointerEvents="none">
        <StatusDot color={color} size={6} />
        <Text numberOfLines={1} style={[stylesheet.chipText, { color }]}>{word === undefined ? count : `${count} ${word}`}</Text>
    </View>
));

/**
 * Decorative connector rail (approach A): descends from the group row, elbows
 * into this child's status dot, and — unless this is the last child — carries
 * on to the next one. Grandchildren just sit one stop deeper on the same rail.
 */
const ChildRail = React.memo(({ last }: { last: boolean }) => (
    <View
        style={stylesheet.railOverlay}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        pointerEvents="none"
    >
        {!last && <View style={stylesheet.railLine} />}
        <View style={stylesheet.railElbow} />
    </View>
));

const GroupRow = React.memo(({
    count,
    kind,
    groupChildren,
    expanded,
    forced,
    onToggle,
}: {
    count: number;
    kind?: string;
    groupChildren: HerdChildSpace[];
    expanded: boolean;
    /** A search holds this group open: the row states it, it does not control it. */
    forced: boolean;
    onToggle: () => void;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [slotWidth, setSlotWidth] = React.useState(0);
    const [fullWidth, setFullWidth] = React.useState(0);
    const counts = groupSummaryCounts(groupChildren);
    const summary = [
        { count: counts.needsYou, word: t('spacesTree.needsYou'), tone: 'error' },
        { count: counts.working, word: t('spacesTree.working'), tone: 'working' },
        { count: counts.done, word: t('spacesTree.done'), tone: 'done' },
    ].filter((entry) => entry.count > 0).slice(0, 2) as Array<{ count: number; word: string; tone: 'error' | 'working' | 'done' }>;
    const noun = t('spacesTree.groupCount', { count, kind });
    const summaryWords = summary.map((entry) => `${entry.count} ${entry.word}`).join(' · ');
    const spokenLabel = [noun, summaryWords].filter(Boolean).join(', ');
    // Chips drop before the child count does: two chips shrink to one (done
    // already dropped by the slice above) while the noun stays whole.
    const crowded = summary.length > 1 && slotWidth > 0 && fullWidth > slotWidth;
    const shown = crowded ? summary.slice(0, 1) : summary;
    const chipColor = (tone: 'error' | 'working' | 'done') => theme.colors.status[tone];
    const chips = (entries: typeof summary) => entries.map((entry) => (
        <Chip key={entry.word} count={entry.count} word={entry.word} color={chipColor(entry.tone)} />
    ));

    const body = (
        <>
            <View style={styles.chevron}>
                {!forced && (
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-forward'}
                        size={16}
                        color={theme.colors.groupped.chevron}
                    />
                )}
            </View>
            <View
                style={styles.groupTitleSlot}
                onLayout={(event) => setSlotWidth(event.nativeEvent.layout.width)}
            >
                <Text numberOfLines={1} style={styles.groupTitle}>{noun}</Text>
                <View style={styles.chipRow}>{chips(shown)}</View>
            </View>
            {summary.length > 1 && (
                <View
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    aria-hidden
                    pointerEvents="none"
                    style={styles.groupSummaryProbe}
                    onLayout={(event) => {
                        const width = event.nativeEvent.layout.width;
                        if (width > 0) setFullWidth(width);
                    }}
                >
                    <Text numberOfLines={1} style={styles.groupTitle}>{noun}</Text>
                    <View style={styles.chipRow}>{chips(summary)}</View>
                </View>
            )}
        </>
    );

    if (forced) {
        return (
            <View style={styles.groupRow} accessible accessibilityRole="text" accessibilityLabel={spokenLabel}>
                {body}
            </View>
        );
    }

    return (
        <Pressable
            onPress={onToggle}
            style={({ pressed }) => [styles.groupRow, pressed && styles.groupRowPressed]}
            android_ripple={{ color: theme.colors.surfaceRipple, foreground: true }}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${spokenLabel}. ${expanded ? t('spacesTree.collapse') : t('spacesTree.expand')}`}
        >
            {body}
        </Pressable>
    );
});

const ChildRow = React.memo(({
    child,
    last,
    onToggle,
    onClose,
    onClosePane,
    onNavigatePane,
    selectedSessionId,
    canClose,
    unseenDoneSessionIds,
}: {
    child: HerdChildSpace;
    /** The rail stops at the last child. */
    last: boolean;
    onToggle: () => void;
    onClose: () => void;
    onClosePane: (pane: HerdrTreePane) => void;
    onNavigatePane?: (sessionId: string) => void;
    selectedSessionId?: string;
    canClose: boolean;
    unseenDoneSessionIds: ReadonlySet<string>;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const navigateToSession = useNavigateToSession();
    const dot = agentStatusColor(child.workspace.agentStatus, theme);
    const agentPanes = child.workspace.tabs.flatMap((tab) => tab.panes).filter((pane) => pane.agentKind !== undefined);
    const singleAgent = agentPanes.length === 1 ? agentPanes[0] : undefined;
    const singleSessionId = singleAgent?.sessionId;
    const label = workspaceName(child.workspace);
    const parts = childLine2Parts(child);
    const line2 = parts.join(' · ');
    const onPress = singleSessionId !== undefined
        ? () => (onNavigatePane ?? navigateToSession)(singleSessionId)
        : agentPanes.length > 1 ? onToggle : undefined;
    const interactive = onPress !== undefined || canClose;

    return (
        <View style={styles.childRow}>
            <ChildRail last={last} />
            <View style={styles.childSeparator} />
            <Pressable
                onPress={onPress}
                onLongPress={canClose ? onClose : undefined}
                style={({ pressed }) => [
                    styles.childPressable,
                    selectedSessionId !== undefined && child.workspace.tabs.some((tab) => tab.panes.some((pane) =>
                        pane.sessionId === selectedSessionId)) && styles.childPressableSelected,
                    pressed && interactive && styles.childPressablePressed,
                ]}
                android_ripple={interactive ? { color: theme.colors.surfaceRipple, foreground: true } : undefined}
                accessibilityRole={interactive ? 'button' : 'text'}
                accessibilityLabel={onPress === undefined
                    ? [label, ...parts].join(', ')
                    : t('spacesTree.openLabel', { label, line2: parts.join(', ') })}
            >
                <StatusDot color={dot.color} isPulsing={dot.pulsing} size={8} />
                <View style={styles.childText}>
                    <Text numberOfLines={1} style={styles.childLabel}>{label}</Text>
                    <Text numberOfLines={1} style={styles.childLine2}>{line2}</Text>
                </View>
            </Pressable>
            {child.expanded && child.panes.map((pane) => (
                <View key={pane.paneId} style={styles.childAgentInset}>
                    <AgentRow
                        pane={pane}
                        first
                        onClose={() => onClosePane(pane)}
                        onNavigatePane={onNavigatePane}
                        compact={false}
                        selected={pane.sessionId !== undefined && pane.sessionId === selectedSessionId}
                        canClose={canClose}
                        unseenDone={pane.sessionId !== undefined && unseenDoneSessionIds.has(pane.sessionId)}
                    />
                </View>
            ))}
        </View>
    );
});

const WorkspaceCard = React.memo(({
    workspace,
    expanded,
    agentCount,
    panes,
    childSpaces,
    groupExpanded,
    searchForced,
    onToggle,
    onToggleGroup,
    onToggleChild,
    onClose,
    onCloseChild,
    onClosePane,
    onNavigatePane,
    compact,
    selectedSessionId,
    canClose,
    unseenDoneSessionIds,
}: {
    workspace: HerdrTreeWorkspace;
    expanded: boolean;
    agentCount: number;
    panes: HerdrTreePane[];
    childSpaces: HerdChildSpace[];
    groupExpanded: boolean;
    /** A search holds this card open: its header states that, it does not control it. */
    searchForced: boolean;
    onToggle: () => void;
    onToggleGroup: () => void;
    onToggleChild: (workspaceId: string) => void;
    onClose: () => void;
    onCloseChild: (workspace: HerdrTreeWorkspace) => void;
    onClosePane: (pane: HerdrTreePane) => void;
    onNavigatePane?: (sessionId: string) => void;
    compact: boolean;
    selectedSessionId?: string;
    canClose: boolean;
    unseenDoneSessionIds: ReadonlySet<string>;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const dot = agentStatusColor(workspace.agentStatus, theme);
    const branch = workspace.worktree?.branch;
    const paneCount = workspace.tabs.reduce((count, tab) => count + tab.panes.length, 0);
    const countLabel = agentCount > 0
        ? t('spacesTree.childAgents', { count: agentCount })
        : paneCount > 0 ? t('spacesTree.shell') : undefined;
    // Approach D: a collapsed card keeps its needs-you count on the header,
    // so attention shows before anything is expanded (chips in the group row
    // carry the rest).
    const needsYou = expanded ? 0 : groupSummaryCounts(childSpaces).needsYou;
    const headerInteractive = !searchForced || canClose;
    const headerLabel = [
        `${workspaceName(workspace)} workspace`,
        countLabel,
        needsYou > 0 ? `${needsYou} ${t('spacesTree.needsYou')}` : undefined,
    ].filter((part) => part !== undefined).join(', ');

    return (
        <View style={[styles.card, compact && styles.cardCompact]}>
            <Pressable
                onPress={searchForced ? undefined : onToggle}
                onLongPress={canClose ? onClose : undefined}
                style={({ pressed }) => [
                    styles.cardHeader,
                    compact && styles.cardHeaderCompact,
                    expanded && styles.cardHeaderExpanded,
                    pressed && headerInteractive && styles.cardHeaderPressed,
                ]}
                android_ripple={headerInteractive ? { color: theme.colors.surfaceRipple, foreground: true } : undefined}
                accessibilityRole={headerInteractive ? 'button' : undefined}
                accessibilityLabel={headerLabel}
            >
                <View style={styles.chevron}>
                    {!searchForced && (
                        <Ionicons
                            name={expanded ? 'chevron-down' : 'chevron-forward'}
                            size={16}
                            color={theme.colors.groupped.chevron}
                        />
                    )}
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
                {needsYou > 0 && (
                    <Chip count={needsYou} color={theme.colors.status.error} />
                )}
                {countLabel !== undefined && <Text style={styles.agentCount}>{countLabel}</Text>}
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
                    unseenDone={pane.sessionId !== undefined && unseenDoneSessionIds.has(pane.sessionId)}
                />
            ))}
            {childSpaces.length > 0 && (
                <GroupRow
                    count={childSpaces.length}
                    kind={groupKind(childSpaces)}
                    groupChildren={childSpaces}
                    expanded={groupExpanded}
                    forced={searchForced}
                    onToggle={onToggleGroup}
                />
            )}
            {groupExpanded && childSpaces.map((child, index) => (
                <ChildRow
                    key={child.workspace.workspaceId}
                    child={child}
                    last={index === childSpaces.length - 1}
                    onToggle={() => onToggleChild(child.workspace.workspaceId)}
                    onClose={() => onCloseChild(child.workspace)}
                    onClosePane={onClosePane}
                    onNavigatePane={onNavigatePane}
                    selectedSessionId={selectedSessionId}
                    canClose={canClose}
                    unseenDoneSessionIds={unseenDoneSessionIds}
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
    loading,
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
    const unseenDoneSessionIds = useUnseenDoneSessionIds();
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

    // The card cannot visually close while its group row is forced open, so
    // collapsing the card closes the group with it.
    const toggleWorkspaceCard = React.useCallback((workspaceId: string) => {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(workspaceId) || next.has(`group:${workspaceId}`)) {
                next.delete(workspaceId);
                next.delete(`group:${workspaceId}`);
            } else {
                next.add(workspaceId);
            }
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

    const searching = searchQuery.trim() !== '';

    const sections = React.useMemo(
        () => [{ key: 'spaces', title: t('spacesTree.title'), data: buildSpaceRows(workspaces, expanded, searchQuery) }],
        [expanded, searchQuery, workspaces],
    );

    const renderItem = React.useCallback(({ item }: { item: HerdSpaceRow }) => (
        <WorkspaceCard
            workspace={item.workspace}
            expanded={item.expanded}
            agentCount={item.agentCount}
            panes={item.panes}
            childSpaces={item.children}
            groupExpanded={item.groupExpanded}
            searchForced={searching && item.groupExpanded}
            onToggle={() => toggleWorkspaceCard(item.workspace.workspaceId)}
            onToggleGroup={() => toggleWorkspace(`group:${item.workspace.workspaceId}`)}
            onToggleChild={(workspaceId) => toggleWorkspace(`child:${workspaceId}`)}
            onClose={() => confirmCloseWorkspace(item.workspace)}
            onCloseChild={confirmCloseWorkspace}
            onClosePane={confirmClosePane}
            onNavigatePane={onNavigatePane}
            compact={compact}
            selectedSessionId={selectedSessionId}
            canClose={canClose}
            unseenDoneSessionIds={unseenDoneSessionIds}
        />
    ), [canClose, compact, confirmClosePane, confirmCloseWorkspace, onNavigatePane, searching, selectedSessionId, toggleWorkspace, toggleWorkspaceCard, unseenDoneSessionIds]);

    if (loading === true) {
        return (
            <View style={[styles.contentContainer, { maxWidth: maxContentWidth }]}>
                <View style={styles.skeleton} />
            </View>
        );
    }

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
                    {(sections[0]?.data.length ?? 0) === 0
                        ? <Text style={styles.empty}>{searching ? t('spacesTree.noMatches') : (emptyText ?? t('spacesTree.empty'))}</Text>
                        : null}
                    {listFooterComponent === undefined ? undefined : <>{listFooterComponent}</>}
                </>}
                onScroll={onScroll}
                scrollEventThrottle={100}
                contentContainerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            />
        </View>
    );
});
