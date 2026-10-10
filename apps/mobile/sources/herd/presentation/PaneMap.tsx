/**
 * One tab's panes as the desk lays them out: a mini-map of the real split,
 * read from Herdr's pane geometry, one tile per pane. A tile names its pane
 * the way every tree row does -- kind glyph, name, status on the right -- and
 * never shows terminal text. Until the geometry answers (or when it no longer
 * matches the tab) the tiles stack, full width.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { HerdrTreePane, HerdrTreeTab } from '@trymuxr/contract';
import { Text } from '@/components/StyledText';
import { StatusDot } from '@/components/StatusDot';
import { AgentGlyph } from '@/components/AgentGlyph';
import { Typography } from '@/constants/Typography';
import { sync } from '@/catalog/sync';
import { agentStatusColor } from '../application/sessionUtils';
import { HERD_STATUS_LABELS, agentLabels, agentWhoLine, isShellLabels } from '../domain/agentPresentation';
import { paneMapTiles, type PaneMapLayout } from '../domain/paneMap';
import { agentNeedsYou, displayedAgentStatus } from '../domain/recentActivity';

/** The smallest a tile gets, so every pane stays a comfortable tap. */
const MIN_TILE = 52;
const GAP = 4;
const STACKED_TILE = 60;

/** A shell's working directory, home folded to `~`. */
export function shellPath(cwd: string | undefined): string | undefined {
    return cwd?.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
}

/** The line under a pane's title: who runs it, or a shell's directory. */
export function paneTaskLine(pane: HerdrTreePane): string | undefined {
    const labels = agentLabels(pane);
    if (isShellLabels(labels)) return shellPath(pane.cwd);
    return agentWhoLine(labels);
}

/** The tab's split, fetched once per tab and pane set; `undefined` until it answers. */
function useTabLayout(tab: HerdrTreeTab): PaneMapLayout | undefined {
    const [layout, setLayout] = React.useState<{ key: string; value: PaneMapLayout } | undefined>();
    const key = `${tab.tabId}\u0000${tab.panes.map((pane) => pane.paneId).join(',')}`;
    React.useEffect(() => {
        let cancelled = false;
        sync.request('herdr.layout', { tabId: tab.tabId })
            .then((result) => { if (!cancelled) setLayout({ key, value: result.layout }); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [key, tab.tabId]);
    return layout?.key === key ? layout.value : undefined;
}

const PaneTile = React.memo(function PaneTile(props: {
    pane: HerdrTreePane;
    width: number;
    height: number;
    current: boolean;
    pending: boolean;
    pendingRequest: boolean;
    canClose: boolean;
    onOpen: (pane: HerdrTreePane) => void;
    onClose: (pane: HerdrTreePane) => void;
    onLongPress?: (pane: HerdrTreePane) => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const { pane } = props;
    const labels = agentLabels(pane);
    const shell = isShellLabels(labels);
    const displayed = displayedAgentStatus(pane.agentStatus, props.pendingRequest);
    const tone = agentStatusColor(displayed, theme);
    const needsYou = agentNeedsYou(pane.agentStatus, props.pendingRequest);
    const task = paneTaskLine(pane);
    const roomy = props.height >= 76 && props.width >= 110;
    // A sliver of a pane (a quarter split on a narrow phone) gives the glyph's
    // room to the name, so it reads as a word rather than a lone ellipsis.
    const narrow = props.width < 88;
    // A close glyph only where it cannot crowd the name; long-press closes everywhere.
    const closable = props.canClose && pane.sessionId !== undefined && !props.pending;
    const showClose = closable && props.height >= 96 && props.width >= 132;
    const state = shell ? 'Shell' : HERD_STATUS_LABELS[displayed];
    // Open and close are siblings, never one button inside another.
    return (
        <View style={{ flex: 1, borderRadius: 10, overflow: 'hidden', borderWidth: props.current ? 2 : needsYou ? 1.5 : 1, borderColor: props.current ? theme.colors.accent : needsYou ? theme.colors.status.error : theme.colors.divider, opacity: props.pending ? 0.5 : 1 }}>
            <Pressable
                onPress={() => props.onOpen(pane)}
                onLongPress={closable ? () => (props.onLongPress ?? props.onClose)(pane) : undefined}
                disabled={pane.sessionId === undefined || props.pending}
                accessibilityRole="button"
                accessibilityState={{ selected: props.current, disabled: pane.sessionId === undefined || props.pending }}
                accessibilityLabel={[props.current ? 'Current pane' : 'Open pane', labels.title, state, task].filter(Boolean).join(', ')}
                accessibilityHint={closable ? (props.onLongPress === undefined ? 'Long-press to close' : 'Long-press to rename or close') : undefined}
                style={({ pressed }) => ({ flex: 1, padding: narrow ? 6 : 8, gap: 3, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {!narrow && <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={14} />}
                    <Text numberOfLines={narrow && props.height >= 56 ? 2 : 1} style={{ ...Typography.default('semiBold'), flex: 1, minWidth: 0, fontSize: 13, color: theme.colors.text }}>{labels.title}</Text>
                    {!shell && <StatusDot color={tone.color} isPulsing={tone.pulsing} size={7} />}
                </View>
                {roomy && task !== undefined && (
                    <Text numberOfLines={props.height >= 120 ? 2 : 1} style={{ ...Typography.default(), fontSize: 11, lineHeight: 15, color: needsYou ? theme.colors.status.error : theme.colors.textSecondary }}>
                        {needsYou ? `${HERD_STATUS_LABELS[displayed]} · ${task}` : task}
                    </Text>
                )}
            </Pressable>
            {showClose && (
                <Pressable
                    onPress={() => props.onClose(pane)}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Close ${labels.title}`}
                    style={({ pressed }) => ({ position: 'absolute', right: 2, bottom: 2, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
                >
                    <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            )}
        </View>
    );
});

export function PaneMap(props: {
    tab: HerdrTreeTab;
    /** The outlined pane: the one open on this device, or the split target. */
    currentPaneId?: string;
    pendingPaneIds?: ReadonlySet<string>;
    /** Agents an online session is holding a request for. */
    pendingRequestIds: ReadonlySet<string>;
    canClose: boolean;
    onOpen: (pane: HerdrTreePane) => void;
    onClose: (pane: HerdrTreePane) => void;
    /** Long-press; without it a long-press closes. */
    onLongPress?: (pane: HerdrTreePane) => void;
    /** Inside a dark sheet. The tiles first draw on this map's own measure,
     *  outside the sheet's render, so the dark scope is repeated here. */
    dark?: boolean;
}): React.JSX.Element {
    const [width, setWidth] = React.useState(0);
    const layout = useTabLayout(props.tab);
    const panes = props.tab.panes;
    const map = paneMapTiles(layout, panes.map((pane) => pane.paneId), width, MIN_TILE);
    const tiles = map?.tiles ?? panes.map((pane, index) => ({ paneId: pane.paneId, left: 0, top: index * STACKED_TILE, width, height: STACKED_TILE }));
    const height = map?.height ?? panes.length * STACKED_TILE;
    const byId = new Map(panes.map((pane) => [pane.paneId, pane]));
    const tiled = (
        <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height: width === 0 ? 0 : height }}>
            {width > 0 && tiles.map((tile) => {
                const pane = byId.get(tile.paneId)!;
                return (
                    <View key={tile.paneId} style={{ position: 'absolute', left: tile.left + GAP / 2, top: tile.top + GAP / 2, width: tile.width - GAP, height: tile.height - GAP }}>
                        <PaneTile
                            pane={pane}
                            width={tile.width - GAP}
                            height={tile.height - GAP}
                            current={pane.paneId === props.currentPaneId}
                            pending={props.pendingPaneIds?.has(pane.paneId) ?? false}
                            pendingRequest={pane.sessionId !== undefined && props.pendingRequestIds.has(pane.sessionId)}
                            canClose={props.canClose}
                            onOpen={props.onOpen}
                            onClose={props.onClose}
                            {...(props.onLongPress === undefined ? {} : { onLongPress: props.onLongPress })}
                        />
                    </View>
                );
            })}
        </View>
    );
    return props.dark === true ? <ScopedTheme name="dark">{tiled}</ScopedTheme> : tiled;
}
