/**
 * One tab's panes as uniform cards: the pane overview.
 *
 * Every real pane is one card (shells included), from the same live tree the
 * session header counts, in tree order. A card is metadata first -- type,
 * title, agent or shell context, lifecycle -- and a passive text snapshot of
 * what the pane shows, read once while the card is on screen and labelled as
 * a snapshot. Nothing here is a live terminal, an image of the desk, or the
 * desk's split geometry; the phone-side selection is the highlight, not
 * whichever pane an agent focused on the host.
 */

import * as React from 'react';
import { FlatList, Pressable, View, useWindowDimensions, type ViewToken } from 'react-native';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { StatusDot } from '@/components/StatusDot';
import { AgentGlyph } from '@/components/AgentGlyph';
import { Typography } from '@/constants/Typography';
import { TerminalPreview, type TerminalPreviewState } from '@/terminal/ui';
import { agentStatusColor } from '../application/sessionUtils';
import { HERD_STATUS_LABELS, agentLabels, agentNameLine, isShellLabels } from '../domain/agentPresentation';
import type { HerdrTreePane } from '@muxr/contract';

const GUTTER = 12;
const MAX_OVERVIEW_WIDTH = 1000;
const SNAPSHOT_LINES = 8;
const PREVIEW_HEIGHT = 112;

/** Columns follow the container, not the device name; big text gets one. */
export function paneGridColumns(containerWidth: number, fontScale: number): number {
    if (fontScale >= 1.3) return 1;
    if (containerWidth >= 840) return 4;
    if (containerWidth >= 600) return 3;
    return 2;
}

function snapshotCaption(state: TerminalPreviewState | undefined): string {
    if (state === undefined || state.kind === 'loading') return 'Snapshot';
    if (state.kind === 'failed') return 'Preview unavailable';
    const at = new Date(state.at);
    const hh = `${at.getHours()}`.padStart(2, '0');
    const mm = `${at.getMinutes()}`.padStart(2, '0');
    return state.kind === 'empty' ? `No recent output · ${hh}:${mm}` : `Snapshot · ${hh}:${mm}`;
}

const PaneCard = React.memo(function PaneCard(props: {
    pane: HerdrTreePane;
    /** The route this card opens: the pane's session, or a caller-resolved route (e.g. a shell pane). */
    sessionId?: string;
    width: number;
    selected: boolean;
    visible: boolean;
    pending: boolean;
    canClose: boolean;
    closeReason: string | undefined;
    onOpen: (pane: HerdrTreePane) => void;
    onClose: (pane: HerdrTreePane) => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const { pane } = props;
    const sessionId = props.sessionId;
    const labels = agentLabels(pane);
    const shell = isShellLabels(labels);
    const status = pane.promptable ? pane.agentStatus : 'unknown';
    const tone = agentStatusColor(status, theme);
    const [snapshot, setSnapshot] = React.useState<TerminalPreviewState>();
    const openable = sessionId !== undefined && !props.pending;
    const closable = props.canClose && sessionId !== undefined && !props.pending;
    const context = shell ? (pane.cwd ?? 'Shell') : `${agentNameLine(labels)} · ${HERD_STATUS_LABELS[status]}`;
    const title = `${labels.title}. ${shell ? 'Shell' : HERD_STATUS_LABELS[status]}`;
    return (
        <View
            accessible={false}
            style={{
                width: props.width,
                marginBottom: GUTTER,
                borderRadius: 14,
                borderWidth: props.selected ? 2 : 1,
                borderColor: props.selected ? theme.colors.accent : theme.colors.divider,
                backgroundColor: theme.colors.surface,
                overflow: 'hidden',
                opacity: props.pending ? 0.55 : 1,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <Pressable
                    onPress={() => props.onOpen(pane)}
                    disabled={!openable}
                    accessibilityRole="button"
                    accessibilityLabel={`${props.selected ? 'Current pane' : 'Open pane'}: ${title}`}
                    accessibilityState={{ selected: props.selected, disabled: !openable }}
                    style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, minHeight: 44, opacity: pressed ? 0.7 : 1 })}
                >
                    <View style={{ paddingTop: 1 }}>
                        <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={18} selected={props.selected} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text numberOfLines={2} style={{ ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.text }}>{labels.title}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                            {!shell && <StatusDot color={tone.color} isPulsing={tone.pulsing} />}
                            <Text numberOfLines={1} style={{ ...Typography.default(), fontSize: 11, color: theme.colors.textSecondary, flexShrink: 1 }}>{context}</Text>
                        </View>
                    </View>
                </Pressable>
                {/* Close is its own 44dp target, never inside the card press. */}
                <Pressable
                    onPress={() => props.onClose(pane)}
                    disabled={!closable}
                    hitSlop={4}
                    accessibilityRole="button"
                    accessibilityLabel={`Close ${labels.title}${props.closeReason === undefined ? '' : `, unavailable: ${props.closeReason}`}`}
                    accessibilityState={{ disabled: !closable }}
                    style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: !closable ? 0.35 : pressed ? 0.6 : 1 })}
                >
                    <Ionicons name="close-outline" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            <View style={{ marginHorizontal: 10, marginBottom: 10, gap: 4 }}>
                <Text style={{ ...Typography.default(), fontSize: 10, color: theme.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4 }}>{snapshotCaption(snapshot)}</Text>
                <View style={{ height: PREVIEW_HEIGHT, borderRadius: 8, overflow: 'hidden' }}>
                    {sessionId !== undefined && (
                        // One passive read while the card is on screen; nothing polls.
                        <TerminalPreview sessionId={sessionId} live={false} paused={!props.visible} maxLines={SNAPSHOT_LINES} nonEmpty onState={setSnapshot} />
                    )}
                </View>
            </View>
        </View>
    );
});

export interface PaneGridViewProps {
    panes: readonly HerdrTreePane[];
    /** The pane selected on this device (its session id), highlighted. */
    selectedSessionId?: string;
    /** Panes with a close in flight: shown, dimmed, not tappable. */
    pendingSessionIds?: ReadonlySet<string>;
    canClose: boolean;
    closeReason?: string;
    onOpen: (pane: HerdrTreePane) => void;
    onClose: (pane: HerdrTreePane) => void;
    /** Sits above the cards inside the same scroll. */
    header?: React.ReactElement | null;
    /** Sits below the cards inside the same scroll (e.g. the Applications section). */
    footer?: React.ReactElement | null;
    /**
     * The route a card opens. Defaults to the pane's session id; a caller may
     * resolve more (shell panes have no session, but `shell:<paneId>` opens).
     */
    sessionIdFor?: (pane: HerdrTreePane) => string | undefined;
    emptyText: string;
    /** When false (sheet closed, app backgrounded) no card reads anything. */
    active?: boolean;
    /**
     * The surface the cards sit on, when it is not the app's: over the
     * terminal they paint dark. Cards mount on this list's own layout and
     * scroll passes, outside any scope above it, so the list names the
     * theme per card.
     */
    surfaceTheme?: 'dark';
}

function CardSurface({ name, children }: { name?: 'dark'; children: React.ReactNode }): React.JSX.Element {
    return name === undefined ? <>{children}</> : <ScopedTheme name={name}>{children}</ScopedTheme>;
}

/** The cards, virtualized; the caller owns the tab, the sheet and the actions. */
export function PaneGridView(props: PaneGridViewProps): React.JSX.Element {
    const { theme } = useUnistyles();
    const { fontScale } = useWindowDimensions();
    const [containerWidth, setContainerWidth] = React.useState(0);
    const columns = paneGridColumns(containerWidth, fontScale);
    const inner = Math.min(containerWidth, MAX_OVERVIEW_WIDTH);
    const cardWidth = Math.max(0, Math.floor((inner - GUTTER * (columns + 1)) / columns));
    const [visibleIds, setVisibleIds] = React.useState<ReadonlySet<string>>(() => new Set());
    const onViewableItemsChanged = React.useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        setVisibleIds(new Set(viewableItems.map((token) => (token.item as HerdrTreePane).paneId)));
    }).current;
    const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 20 }).current;
    const active = props.active !== false;
    return (
        <View style={{ flex: 1 }} onLayout={({ nativeEvent }) => setContainerWidth(nativeEvent.layout.width)}>
            {containerWidth > 0 && (
                <FlatList
                    key={columns}
                    data={props.panes}
                    keyExtractor={(pane) => pane.paneId}
                    numColumns={columns}
                    columnWrapperStyle={columns > 1 ? { gap: GUTTER } : undefined}
                    contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: GUTTER, paddingBottom: GUTTER, width: inner, alignSelf: 'center' }}
                    ListHeaderComponent={props.header ?? null}
                    ListFooterComponent={props.footer ?? null}
                    ListEmptyComponent={<Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center', paddingVertical: 32 }}>{props.emptyText}</Text>}
                    onViewableItemsChanged={onViewableItemsChanged}
                    viewabilityConfig={viewabilityConfig}
                    initialNumToRender={8}
                    windowSize={3}
                    keyboardShouldPersistTaps="always"
                    renderItem={({ item }) => {
                        const sessionId = props.sessionIdFor ? props.sessionIdFor(item) : item.sessionId;
                        return (
                        <CardSurface name={props.surfaceTheme}>
                        <PaneCard
                            pane={item}
                            sessionId={sessionId}
                            width={cardWidth}
                            selected={sessionId !== undefined && sessionId === props.selectedSessionId}
                            visible={active && visibleIds.has(item.paneId)}
                            pending={sessionId !== undefined && (props.pendingSessionIds?.has(sessionId) ?? false)}
                            canClose={props.canClose}
                            closeReason={props.closeReason}
                            onOpen={props.onOpen}
                            onClose={props.onClose}
                        />
                        </CardSurface>
                        );
                    }}
                />
            )}
        </View>
    );
}
