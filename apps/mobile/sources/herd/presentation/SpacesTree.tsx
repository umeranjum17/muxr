import * as React from 'react';
import deepEqual from 'fast-deep-equal';
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
import { buildSpaceRows, displayedWorkspaceNames, effectiveExpandedSpaces, groupKind, groupSummaryCounts, workspaceCloseMessage, workspaceName, type HerdChildSpace, type HerdSpaceRow } from '../domain/herdTree';
import { agentIdentityLine, agentKindLine, agentLabels, agentNameLine, agentStateLabel, isShellLabels } from '../domain/agentPresentation';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { SectionLabel } from '@/components/ui';
import { t } from '@/text';
import { AgentGlyph } from '@/components/AgentGlyph';
import { layout } from '@/components/layout';
import { useDeviceAuthority } from '@/pairing';
import { renameInHerdr, renamePane, showNameActions } from '../application/renameInHerdr';

// Tree geometry in dp from the card's left edge. Depth 1 hangs off the card's
// own rail; each deeper level hangs one step in, off its spawner's glyph.
const RAIL = 2;
// The agent glyph, at the parent rows' size; rails stop GAP short of it.
const GLYPH = 16;
const GAP = 3;
const CHILD_INSET = 28;
const DEPTH_STEP = 16;
// ponytail: deeper lineage clamps to this indent (a 270dp phone keeps its
// text); a clamped row draws as its parent's sibling but is never hidden.
const MAX_DRAWN_DEPTH = 4;
const childInset = (depth: number) => CHILD_INSET + (depth - 1) * DEPTH_STEP;
const glyphCenter = (depth: number) => childInset(depth) + GLYPH / 2;
/** The rail joining depth-`depth` siblings: the card's rail, else the spawner's glyph column. */
const railLeft = (depth: number) => (depth <= 1 ? 17 : glyphCenter(depth - 1) - RAIL / 2);

const stylesheet = StyleSheet.create((theme) => ({
    // Matches a Live card while the host is away.
    stale: {
        opacity: 0.55,
    },
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
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        minHeight: 48,
    },
    cardHeaderLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    // A folded card's family, one line under its name (chevron 16 + dot 8 + two gaps).
    cardHeaderSummary: {
        marginLeft: 40,
        marginTop: 4,
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
    nameSuffix: {
        color: theme.colors.textSecondary,
        fontWeight: '400',
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
        flexShrink: 0,
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
        paddingLeft: 28,
        paddingRight: 16,
        paddingVertical: 10,
        minHeight: 40,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    groupRowCompact: {
        minHeight: 36,
    },
    groupTitleSlot: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    groupTitle: {
        flexShrink: 1,
        fontSize: 13,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    groupTitleCompact: {
        fontSize: 12,
    },
    // Off-screen and wide enough never to clip, so the probe measures the
    // summary's natural width.
    groupSummaryProbeHost: {
        position: 'absolute',
        top: -1000,
        left: 0,
        width: 4000,
        opacity: 0,
    },
    groupSummaryProbe: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    chipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        backgroundColor: theme.colors.surface,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingHorizontal: 5,
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
        right: 0,
        top: 0,
        bottom: 0,
    },
    railLine: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: RAIL,
        backgroundColor: theme.colors.groupped.rail,
    },
    railStem: {
        position: 'absolute',
        top: '50%',
        marginTop: GLYPH / 2 + GAP,
        bottom: 0,
        width: RAIL,
        backgroundColor: theme.colors.groupped.rail,
    },
    railElbow: {
        position: 'absolute',
        top: 0,
        height: '50%',
        borderLeftWidth: RAIL,
        borderBottomWidth: RAIL,
        borderBottomLeftRadius: 10,
        borderColor: theme.colors.groupped.rail,
    },
    childRow: {
        paddingRight: 16,
    },
    childSeparator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    childPressable: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
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
    childLabelQuiet: {
        color: theme.colors.textSecondary,
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
    /** Drawn from the last Home this device saw: dimmed, and nothing closes until the host answers. */
    stale?: boolean;
}

/** One pane as a tree row: its kind's glyph, name, task line, status on the right edge. */
export const AgentRow = React.memo(({
    pane,
    first,
    onLongPress,
    onNavigatePane,
    compact,
    selected,
    canClose,
    unseenDone,
    subtitle: subtitleOverride,
}: {
    pane: HerdrTreePane;
    first?: boolean;
    onLongPress: (pane: HerdrTreePane) => void;
    onNavigatePane?: (sessionId: string) => void;
    compact: boolean;
    selected: boolean;
    canClose: boolean;
    unseenDone: boolean;
    /** Replaces the identity line, e.g. a shell's working directory. */
    subtitle?: string;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const navigateToSession = useNavigateToSession();
    const dot = agentStatusColor(pane.agentStatus, theme);
    const labels = agentLabels(pane);
    const sessionId = pane.sessionId;
    const shell = isShellLabels(labels);
    const title = labels.title;
    const subtitle = subtitleOverride ?? agentIdentityLine(labels);
    // One weight rule: bright means "has something for you". A finished
    // outcome you have not opened stays loud; settled-and-seen goes quiet.
    const quiet = (pane.agentStatus === 'done' || pane.agentStatus === 'idle') && !unseenDone;

    return (
        <View style={[styles.agentRow, compact && styles.agentRowCompact]}>
            {first !== true && <View style={styles.separator} />}
            <Pressable
                onPress={sessionId === undefined ? undefined : () => (onNavigatePane ?? navigateToSession)(sessionId)}
                onLongPress={canClose ? () => onLongPress(pane) : undefined}
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
 * A child's second line, in parts: its one agent's kind (or identity when
 * unnamed) and state, else a count, else what it is. Rendered with ' · ', spoken with ', '.
 */
function childLine2Parts(child: HerdChildSpace): string[] {
    const panes = child.workspace.tabs.flatMap((tab) => tab.panes);
    const agentPanes = panes.filter((pane) => pane.agentKind !== undefined);
    if (panes.length === 0) return [t('spacesTree.childEmpty')];
    if (agentPanes.length === 0) return [t('spacesTree.shell')];
    if (agentPanes.length > 1) return [t('spacesTree.childAgents', { count: agentPanes.length })];
    const agent = agentPanes[0];
    if (agent === undefined) return [t('spacesTree.childEmpty')];
    const labels = agentLabels(agent);
    // A named agent already leads the row, so this line only says what runs it.
    return [childAgentName(child) === undefined ? agentNameLine(labels) : agentKindLine(labels), agentStateLabel(agent.agentStatus)];
}

/** A child's one agent's Herdr name, verbatim, when Herdr has one. */
function childAgentName(child: HerdChildSpace): string | undefined {
    const agentPanes = child.workspace.tabs.flatMap((tab) => tab.panes).filter((pane) => pane.agentKind !== undefined);
    if (agentPanes.length !== 1) return undefined;
    return agentPanes[0]?.agentName?.trim() || undefined;
}

/** A group-subheader status pill: colored dot + mono count, visual only (subheader label speaks it). */
const Chip = React.memo(({ count, word, color }: { count: number; word?: string; color: string }) => (
    <View style={stylesheet.chip} pointerEvents="none">
        <StatusDot color={color} size={6} />
        <Text numberOfLines={1} style={[stylesheet.chipText, { color }]}>{word === undefined ? count : `${count} ${word}`}</Text>
    </View>
));

const railHidden = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
    'aria-hidden': true,
    pointerEvents: 'none',
} as const;

/**
 * Decorative connector rails (approach A) behind one descendant's whole block:
 * every ancestor rail that carries on past it, and its own rail unless it is
 * the last sibling. Its elbow into its dot is drawn by the row itself.
 */
const TreeRails = React.memo(({ depth, rails, last }: { depth: number; rails: readonly boolean[]; last: boolean }) => (
    <View style={stylesheet.railOverlay} {...railHidden}>
        {rails.slice(0, depth - 1).map((carries, index) => carries
            ? <View key={index} style={[stylesheet.railLine, { left: railLeft(index + 1) }]} />
            : null)}
        {!last && <View style={[stylesheet.railLine, { left: railLeft(depth) }]} />}
    </View>
));

/** The elbow from this row's rail up to its glyph. */
const RowElbow = React.memo(({ depth }: { depth: number }) => (
    <View style={stylesheet.railOverlay} {...railHidden}>
        <View style={[stylesheet.railElbow, { left: railLeft(depth), width: childInset(depth) - GAP - railLeft(depth) }]} />
    </View>
));

/** The stem from under this row's glyph down to its own children, drawn over a selected row. */
const RowStem = React.memo(({ depth }: { depth: number }) => (
    <View style={stylesheet.railOverlay} {...railHidden}>
        <View style={[stylesheet.railStem, { left: railLeft(depth + 1) }]} />
    </View>
));

type SummaryEntry = { count: number; word: string; tone: 'error' | 'working' | 'done' };

/** A family in words: "10 tasks" and up to two non-zero states, needs you first. */
function familySummary(children: readonly HerdChildSpace[]): { noun: string; entries: SummaryEntry[]; spoken: string } {
    const counts = groupSummaryCounts(children);
    const entries = ([
        { count: counts.needsYou, word: t('spacesTree.needsYou'), tone: 'error' },
        { count: counts.working, word: t('spacesTree.working'), tone: 'working' },
        { count: counts.done, word: t('spacesTree.done'), tone: 'done' },
    ] as SummaryEntry[]).filter((entry) => entry.count > 0).slice(0, 2);
    const noun = t('spacesTree.groupCount', { count: children.length, kind: groupKind(children) });
    return { noun, entries, spoken: [noun, ...entries.map((entry) => `${entry.count} ${entry.word}`)].join(', ') };
}

/**
 * The family's count and state chips on one line. Chips drop before the
 * count does: two chips shrink to one (done already dropped by the slice
 * above) while the noun stays whole. Visual only: its container speaks it.
 */
const FamilySummary = React.memo(({ groupChildren, compact }: { groupChildren: HerdChildSpace[]; compact: boolean }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [slotWidth, setSlotWidth] = React.useState(0);
    const [fullWidth, setFullWidth] = React.useState(0);
    const { noun, entries } = familySummary(groupChildren);
    const crowded = entries.length > 1 && slotWidth > 0 && fullWidth > slotWidth;
    const shown = crowded ? entries.slice(0, 1) : entries;
    const chips = (list: SummaryEntry[]) => list.map((entry) => (
        <Chip key={entry.word} count={entry.count} word={entry.word} color={theme.colors.status[entry.tone]} />
    ));
    const title = [styles.groupTitle, compact && styles.groupTitleCompact];

    return (
        <>
            <View
                style={styles.groupTitleSlot}
                onLayout={(event) => setSlotWidth(event.nativeEvent.layout.width)}
                {...railHidden}
            >
                <Text numberOfLines={1} style={title}>{noun}</Text>
                <View style={styles.chipRow}>{chips(shown)}</View>
            </View>
            {entries.length > 1 && (
                <View style={styles.groupSummaryProbeHost} {...railHidden}>
                    <View
                        style={styles.groupSummaryProbe}
                        onLayout={(event) => {
                            const width = event.nativeEvent.layout.width;
                            if (width > 0) setFullWidth(width);
                        }}
                    >
                        <Text numberOfLines={1} style={title}>{noun}</Text>
                        <View style={styles.chipRow}>{chips(entries)}</View>
                    </View>
                </View>
            )}
        </>
    );
});

/**
 * Quiet subheader naming the family and its counts: it states the subtree,
 * it does not control it — the card header is the single disclosure.
 * Indented to the child glyph column so it reads as the rail's label.
 */
const GroupSubheader = React.memo(({ groupChildren, compact }: { groupChildren: HerdChildSpace[]; compact: boolean }) => (
    <View
        style={[stylesheet.groupRow, compact && stylesheet.groupRowCompact]}
        accessible
        accessibilityRole="text"
        accessibilityLabel={familySummary(groupChildren).spoken}
    >
        <FamilySummary groupChildren={groupChildren} compact={compact} />
    </View>
));

const ChildRow = React.memo(({
    child,
    name,
    onToggle,
    onLongPress,
    onLongPressPane,
    onNavigatePane,
    selectedSessionId,
    canClose,
    unseenDoneSessionIds,
}: {
    child: HerdChildSpace;
    name: string;
    onToggle: (workspaceId: string) => void;
    onLongPress: (workspace: HerdrTreeWorkspace) => void;
    onLongPressPane: (pane: HerdrTreePane) => void;
    onNavigatePane?: (sessionId: string) => void;
    selectedSessionId?: string;
    canClose: boolean;
    unseenDoneSessionIds: ReadonlySet<string>;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const navigateToSession = useNavigateToSession();
    const depth = Math.min(child.depth, MAX_DRAWN_DEPTH);
    const inset = childInset(depth);
    const dot = agentStatusColor(child.workspace.agentStatus, theme);
    const panes = child.workspace.tabs.flatMap((tab) => tab.panes);
    const agentPanes = panes.filter((pane) => pane.agentKind !== undefined);
    const singleAgent = agentPanes.length === 1 ? agentPanes[0] : undefined;
    const singleSessionId = singleAgent?.sessionId;
    const agentName = childAgentName(child);
    const label = agentName === undefined ? name : `${agentName}, ${name}`;
    const baseName = workspaceName(child.workspace);
    const suffix = name.startsWith(`${baseName} · `) ? name.slice(baseName.length) : undefined;
    const parts = childLine2Parts(child);
    const line2 = parts.join(' · ');
    const onPress = singleSessionId !== undefined
        ? () => (onNavigatePane ?? navigateToSession)(singleSessionId)
        : agentPanes.length > 1 ? () => onToggle(child.workspace.workspaceId) : undefined;
    const interactive = onPress !== undefined || canClose;
    // The agent row's weight rule: settled and seen goes quiet.
    const quiet = (child.workspace.agentStatus === 'done' || child.workspace.agentStatus === 'idle')
        && !panes.some((pane) => pane.sessionId !== undefined && unseenDoneSessionIds.has(pane.sessionId));
    // The parent rows' mark: the lead agent's kind, else the shell.
    const leadLabels = agentPanes[0] === undefined ? undefined : agentLabels(agentPanes[0]);
    const glyphName = leadLabels === undefined || isShellLabels(leadLabels) ? 'shell' : leadLabels.agentKind ?? leadLabels.agentName;

    return (
        <View style={styles.childRow}>
            <TreeRails depth={depth} rails={child.rails} last={child.last} />
            <View style={[styles.childSeparator, { marginLeft: inset + GLYPH + 9 }]} />
            <View>
                <RowElbow depth={depth} />
                <Pressable
                    onPress={onPress}
                    onLongPress={canClose ? () => onLongPress(child.workspace) : undefined}
                    style={({ pressed }) => [
                        styles.childPressable,
                        { marginLeft: inset },
                        selectedSessionId !== undefined && panes.some((pane) => pane.sessionId === selectedSessionId)
                            && styles.childPressableSelected,
                        pressed && interactive && styles.childPressablePressed,
                    ]}
                    android_ripple={interactive ? { color: theme.colors.surfaceRipple, foreground: true } : undefined}
                    accessibilityRole={interactive ? 'button' : 'text'}
                    accessibilityLabel={onPress === undefined
                        ? [label, ...parts].join(', ')
                        : t('spacesTree.openLabel', { label, line2: parts.join(', ') })}
                >
                    <AgentGlyph name={glyphName} size={GLYPH} />
                    <View style={styles.childText}>
                        <Text numberOfLines={1} style={[styles.childLabel, quiet && styles.childLabelQuiet]}>
                            {agentName === undefined
                                ? suffix === undefined ? name : <>{baseName}<Text style={styles.nameSuffix}>{suffix}</Text></>
                                : <>{agentName}<Text style={styles.nameSuffix}>{` · ${name}`}</Text></>}
                        </Text>
                        <Text numberOfLines={1} style={styles.childLine2}>{line2}</Text>
                    </View>
                    <StatusDot color={quiet ? theme.colors.status.disconnected : dot.color} isPulsing={dot.pulsing} size={7} />
                </Pressable>
                {child.hasChildren && <RowStem depth={depth} />}
            </View>
            {child.expanded && child.panes.length > 0 && (
                <View style={{ paddingLeft: inset + 28 }}>
                    {child.hasChildren && <View style={[styles.railLine, { left: railLeft(depth + 1) }]} {...railHidden} />}
                    {child.panes.map((pane) => (
                        <AgentRow
                            key={pane.paneId}
                            pane={pane}
                            first
                            onLongPress={onLongPressPane}
                            onNavigatePane={onNavigatePane}
                            compact={false}
                            selected={pane.sessionId !== undefined && pane.sessionId === selectedSessionId}
                            canClose={canClose}
                            unseenDone={pane.sessionId !== undefined && unseenDoneSessionIds.has(pane.sessionId)}
                        />
                    ))}
                </View>
            )}
        </View>
    );
});

const WorkspaceCard = React.memo(({
    workspace,
    name,
    childNames,
    expanded,
    agentCount,
    panes,
    childSpaces,
    searchForced,
    onToggle,
    onToggleChild,
    onLongPress,
    onLongPressPane,
    onNavigatePane,
    compact,
    selectedSessionId,
    canClose,
    unseenDoneSessionIds,
}: {
    workspace: HerdrTreeWorkspace;
    name: string;
    childNames: readonly string[];
    expanded: boolean;
    agentCount: number;
    panes: HerdrTreePane[];
    childSpaces: HerdChildSpace[];
    /** A search holds this card open: its header states that, it does not control it. */
    searchForced: boolean;
    onToggle: (workspaceId: string) => void;
    onToggleChild: (workspaceId: string) => void;
    onLongPress: (workspace: HerdrTreeWorkspace) => void;
    onLongPressPane: (pane: HerdrTreePane) => void;
    onNavigatePane?: (sessionId: string) => void;
    compact: boolean;
    selectedSessionId?: string;
    canClose: boolean;
    unseenDoneSessionIds: ReadonlySet<string>;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const dot = agentStatusColor(workspace.agentStatus, theme);
    const baseName = workspaceName(workspace);
    const suffix = name.startsWith(`${baseName} · `) ? name.slice(baseName.length) : undefined;
    const branch = workspace.worktree?.branch;
    const paneCount = workspace.tabs.reduce((count, tab) => count + tab.panes.length, 0);
    const countLabel = agentCount > 0
        ? t('spacesTree.childAgents', { count: agentCount })
        : paneCount > 0 ? t('spacesTree.shell') : undefined;
    // A folded card summarises its family under its name — count, needs
    // you, working — so attention shows before anything is expanded; open,
    // the same line moves down to head the rail.
    const folded = !expanded && childSpaces.length > 0;
    const headerInteractive = !searchForced || canClose;
    const headerLabel = [
        `${name} workspace`,
        countLabel,
        folded ? familySummary(childSpaces).spoken : undefined,
    ].filter((part) => part !== undefined).join(', ');
    // The header is the single disclosure control: its label speaks the verb
    // and its state carries expanded, truthfully claiming the whole subtree.
    const spokenHeaderLabel = searchForced
        ? headerLabel
        : `${headerLabel}, ${expanded ? t('spacesTree.collapse') : t('spacesTree.expand')}`;

    return (
        <View style={[styles.card, compact && styles.cardCompact]}>
            <Pressable
                onPress={searchForced ? undefined : () => onToggle(workspace.workspaceId)}
                onLongPress={canClose ? () => onLongPress(workspace) : undefined}
                style={({ pressed }) => [
                    styles.cardHeader,
                    compact && styles.cardHeaderCompact,
                    expanded && styles.cardHeaderExpanded,
                    pressed && headerInteractive && styles.cardHeaderPressed,
                ]}
                android_ripple={headerInteractive ? { color: theme.colors.surfaceRipple, foreground: true } : undefined}
                accessibilityRole={headerInteractive ? 'button' : undefined}
                accessibilityState={searchForced ? undefined : { expanded }}
                accessibilityLabel={spokenHeaderLabel}
            >
                <View style={styles.cardHeaderLine}>
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
                        {suffix === undefined ? name : <>{baseName}<Text style={styles.nameSuffix}>{suffix}</Text></>}
                    </Text>
                    {branch !== undefined && (
                        <View style={styles.branchPill}>
                            <Text numberOfLines={1} style={styles.branchPillText}>{branch}</Text>
                        </View>
                    )}
                    {countLabel !== undefined && <Text numberOfLines={1} style={styles.agentCount}>{countLabel}</Text>}
                </View>
                {folded && (
                    <View style={[styles.cardHeaderLine, styles.cardHeaderSummary]}>
                        <FamilySummary groupChildren={childSpaces} compact={compact} />
                    </View>
                )}
            </Pressable>
            {expanded && panes.map((pane, index) => (
                <AgentRow
                    key={pane.paneId}
                    pane={pane}
                    first={index === 0}
                    onLongPress={onLongPressPane}
                    onNavigatePane={onNavigatePane}
                    compact={compact}
                    selected={pane.sessionId !== undefined && pane.sessionId === selectedSessionId}
                    canClose={canClose}
                    unseenDone={pane.sessionId !== undefined && unseenDoneSessionIds.has(pane.sessionId)}
                />
            ))}
            {expanded && childSpaces.length > 0 && (
                <GroupSubheader groupChildren={childSpaces} compact={compact} />
            )}
            {expanded && childSpaces.map((child, index) => (
                <ChildRow
                    key={child.workspace.workspaceId}
                    child={child}
                    name={childNames[index]!}
                    onToggle={onToggleChild}
                    onLongPress={onLongPress}
                    onLongPressPane={onLongPressPane}
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
    stale = false,
}: SpacesTreeProps) => {
    const styles = stylesheet;
    const compact = density === 'compact';
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const canClose = authority === 'control' && !authorityLoading && !stale;
    const unseenDoneSessionIds = useUnseenDoneSessionIds();
    const [choices, setChoices] = React.useState<ReadonlyMap<string, boolean>>(() => new Map());
    const expanded = React.useMemo(
        () => effectiveExpandedSpaces(defaultExpandedWorkspaceIds, choices),
        [defaultExpandedWorkspaceIds, choices],
    );

    const toggleWorkspace = React.useCallback((workspaceId: string) => {
        setChoices((previous) => new Map(previous).set(
            workspaceId,
            !effectiveExpandedSpaces(defaultExpandedWorkspaceIds, previous).has(workspaceId),
        ));
    }, [defaultExpandedWorkspaceIds]);
    const toggleChildWorkspace = React.useCallback(
        (workspaceId: string) => toggleWorkspace(`child:${workspaceId}`),
        [toggleWorkspace],
    );

    const searching = searchQuery.trim() !== '';
    const previousRows = React.useRef(new Map<string, HerdSpaceRow>());
    const sections = React.useMemo(() => {
        const rows = buildSpaceRows(workspaces, expanded, searchQuery).map((row) => {
            const previous = previousRows.current.get(row.workspace.workspaceId);
            return previous !== undefined && deepEqual(previous, row) ? previous : row;
        });
        previousRows.current = new Map(rows.map((row) => [row.workspace.workspaceId, row]));
        return [{ key: 'spaces', title: t('spacesTree.title'), data: rows }];
    }, [expanded, searchQuery, workspaces]);
    const names = React.useMemo(() => displayedWorkspaceNames(sections[0]!.data), [sections]);
    const namesRef = React.useRef(names);
    namesRef.current = names;
    const previousChildNames = React.useRef(new Map<string, readonly string[]>());
    const childNames = React.useMemo(() => {
        const next = new Map<string, readonly string[]>();
        for (const row of sections[0]!.data) {
            const values = row.children.map((child) => names.get(child.workspace.workspaceId)!);
            const previous = previousChildNames.current.get(row.workspace.workspaceId);
            next.set(row.workspace.workspaceId, previous !== undefined && deepEqual(previous, values) ? previous : values);
        }
        previousChildNames.current = next;
        return next;
    }, [names, sections]);

    const confirmCloseWorkspace = React.useCallback((workspace: HerdrTreeWorkspace) => {
        const name = namesRef.current.get(workspace.workspaceId)!;
        Modal.alert('Close workspace?', workspaceCloseMessage(workspace, name), [
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
        Modal.alert('Close pane?', `Closes only the pane for "${labels.title}"${identity} in herdr. If that would also close its tab, nothing closes.`, [
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

    const workspaceActions = React.useCallback((workspace: HerdrTreeWorkspace) => {
        const name = namesRef.current.get(workspace.workspaceId)!;
        showNameActions(name, () => void renameInHerdr('workspace', workspace.workspaceId, workspace.label?.trim() || name),
            { label: 'Close workspace', onPress: () => confirmCloseWorkspace(workspace) });
    }, [confirmCloseWorkspace]);

    const paneActions = React.useCallback((pane: HerdrTreePane) => {
        showNameActions(agentLabels(pane).title, () => void renamePane(pane),
            pane.sessionId === undefined ? undefined : { label: 'Close pane', onPress: () => confirmClosePane(pane) });
    }, [confirmClosePane]);

    const renderItem = React.useCallback(({ item }: { item: HerdSpaceRow }) => (
        <View style={stale && styles.stale}>
            <WorkspaceCard
                workspace={item.workspace}
                name={names.get(item.workspace.workspaceId)!}
                childNames={childNames.get(item.workspace.workspaceId)!}
                expanded={item.expanded}
                agentCount={item.agentCount}
                panes={item.panes}
                childSpaces={item.children}
                searchForced={searching && item.children.length > 0}
                // Stable handlers keep an unchanged card from re-rendering
                // every time the list around it does.
                onToggle={toggleWorkspace}
                onToggleChild={toggleChildWorkspace}
                onLongPress={workspaceActions}
                onLongPressPane={paneActions}
                onNavigatePane={onNavigatePane}
                compact={compact}
                selectedSessionId={selectedSessionId}
                canClose={canClose}
                unseenDoneSessionIds={unseenDoneSessionIds}
            />
        </View>
    ), [canClose, childNames, compact, paneActions, workspaceActions, names, onNavigatePane, searching, selectedSessionId, stale, toggleChildWorkspace, toggleWorkspace, unseenDoneSessionIds]);

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
