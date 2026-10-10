import * as React from 'react';
import { type FlatList, Pressable, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { Text } from '@/components/StyledText';
import { storage, useHomeHerd, useHomeNeedsYouIds, useLifecycleEvents, useSocketStatus } from '@/catalog/store';
import { useDeviceAuthority } from '@/pairing';
import { t } from '@/text';
import { agentStatusColor } from '../application/sessionUtils';
import { herdPanes } from '../domain/herd';
import {
    holdLiveTerminalOrder,
    liveTerminalBucket,
    sharedLiveTerminalCards,
    sharedLiveTerminalOrderSettlesAt,
    subscribeLiveTerminalOrder,
    selectLiveTerminalCards,
    type LiveTerminalOrderCard,
} from '../application/liveTerminalOrder';
import { useActivityAcknowledgements } from '../application/useActivityAcknowledgements';
import { agentLabels, agentWhoLine, herdrPaneForSession, isShellLabels, liveCardState } from '../domain/agentPresentation';
import { showPaneActions } from '../application/renameInHerdr';
import { agentNeedsYou, needsYouActivityRows, statusNeedsYou, unseenActivityRows, type RecentActivityRow } from '../domain/recentActivity';
import type { LifecycleEvent } from '@trymuxr/contract';
import { AgentGlyph } from '@/components/AgentGlyph';
import { SectionLabel } from '@/components/ui';
import { TerminalPreview } from '@/terminal/ui';
import { useNavigateToSession } from '../application/useNavigateToSession';
import { RecentActivity } from './RecentActivity';

const CARD_WIDTH = 300;
const CARD_HEIGHT = 200;
const CARD_GAP = 12;
const STRIP_GUTTER = 16;
// A reorder waits this long after the last touch or scroll, so a card never
// moves while the eye is still following the flick that brought it there.
const REORDER_GRACE_MS = 1_500;
// Cards slide to their new places; with reduced motion they simply appear there.
const reorderTransition = LinearTransition.duration(280).reduceMotion(ReduceMotion.System);

const stylesheet = StyleSheet.create((theme) => ({
    // Home's section rhythm: 20pt from the content above to a section label,
    // 10pt from the label to what it names. The header row is 28pt for the
    // attention dot's target, so the label sits 6pt inside it on each side.
    strip: { paddingTop: 14 },
    header: {
        minHeight: 28,
        paddingHorizontal: STRIP_GUTTER,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    attentionIndicator: { width: 18, height: 28, alignItems: 'center', justifyContent: 'center' },
    attentionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.status.error },
    reconnecting: { marginLeft: 'auto', color: theme.colors.textSecondary, fontSize: 11, lineHeight: 14 },
    zeroLine: {
        marginHorizontal: STRIP_GUTTER,
        marginTop: 4,
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    card: {
        height: CARD_HEIGHT,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    attentionCard: { borderWidth: 1.5, borderColor: theme.colors.status.error },
    cardBody: { flex: 1, backgroundColor: '#0c0c0b' },
    cardFooter: { minHeight: 48, paddingHorizontal: 10, paddingVertical: 6 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    footerCopy: { flex: 1, minWidth: 0, gap: 2 },
    title: { color: theme.colors.text, fontSize: 13, lineHeight: 16, fontWeight: '600' },
    identity: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 14 },
    status: {
        flexShrink: 0,
        marginLeft: 8,
    },
    statusText: { fontSize: 11, lineHeight: 14, fontVariant: ['tabular-nums'] },
}));

/** What a Live card badge needs: badge components come from the owning
 *  screen (a feature can't import plans without a new import cycle), so the
 *  shape is declared here and matched structurally there. */
export interface LiveCardBadgeInfo {
    sessionId: string;
    agentKind: string;
    working: boolean;
    /** Call before acting: the card mistakes the badge tap for its own. */
    notePress: () => void;
}

interface CardProps {
    card: LiveTerminalOrderCard;
    events: readonly LifecycleEvent[];
    now: number;
    width: number;
    height: number;
    paused: boolean;
    disconnected: boolean;
    unseenDone: boolean;
    canRename: boolean;
    Badge?: React.ComponentType<LiveCardBadgeInfo>;
}

function terminalIsLive(card: LiveTerminalOrderCard): boolean {
    return card.agentStatus === 'working' || card.agentStatus === 'starting' || card.agentStatus === 'blocked';
}

const LiveTerminalCard = React.memo(({ card, events, now, width, height, paused, disconnected, unseenDone, canRename, Badge }: CardProps) => {
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const labels = agentLabels(card);
    const needsYou = agentNeedsYou(card.agentStatus, card.pendingRequest);
    // A pending request on a working pane reads as blocked; a failed pane keeps its own label.
    const status = needsYou && !statusNeedsYou(card.agentStatus) ? 'blocked' : card.agentStatus;
    const dot = agentStatusColor(status, theme);
    const live = terminalIsLive(card);
    const shell = isShellLabels(labels);
    const state = liveCardState(labels, status, card.id, events, now);
    const planAccount = storage((state) => herdrPaneForSession(state.herdrWorkspaces, card.id)?.planAccount);
    // A badge tap lands on this pressable too: it opens the agent under the
    // badge's own sheet unless the badge marks its tap first.
    const lastBadgePress = React.useRef(0);
    const rename = () => {
        const pane = herdrPaneForSession(storage.getState().herdrWorkspaces, card.id);
        if (pane !== undefined) showPaneActions(pane);
    };
    return (
        <Pressable
            onPress={() => { if (Date.now() - lastBadgePress.current < 750) return; navigateToSession(card.id); }}
            onLongPress={canRename ? rename : undefined}
            accessibilityRole="button"
            accessibilityLabel={state.accessibilityLabel}
            style={({ pressed }) => [
                stylesheet.card,
                liveTerminalBucket(card.agentStatus, card.pendingRequest) === 'attention' && stylesheet.attentionCard,
                { width, height, opacity: pressed ? 0.8 : disconnected ? 0.55 : 1 },
            ]}
        >
            <View style={stylesheet.cardBody}>
                <TerminalPreview sessionId={card.id} paused={paused} live={live} dimmed={!live && !unseenDone} emptyState />
            </View>
            <View style={stylesheet.cardFooter}>
                <View style={stylesheet.titleRow}>
                    <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={16} />
                    <View style={stylesheet.footerCopy}>
                        <Text numberOfLines={1} style={stylesheet.title}>{labels.title}</Text>
                        <Text numberOfLines={1} style={stylesheet.identity}>{agentWhoLine(labels)}{planAccount === undefined ? '' : ` · on ${planAccount}`}</Text>
                    </View>
                    <View style={stylesheet.status}>
                        <Text numberOfLines={1} style={[stylesheet.statusText, { color: dot.color }]}>
                            {state.label}
                        </Text>
                    </View>
                </View>
                {Badge !== undefined && labels.agentKind !== undefined && (
                    <Badge
                        sessionId={card.id}
                        agentKind={labels.agentKind}
                        working={!needsYou && card.agentStatus === 'working'}
                        notePress={() => { lastBadgePress.current = Date.now(); }}
                    />
                )}
            </View>
        </Pressable>
    );
});

export const LiveTerminalsRow = React.memo(({
    showZeroState = true,
    cardBadge,
}: {
    showZeroState?: boolean;
    /** A per-card line under the agent's name (the empty-room badge on Home). */
    cardBadge?: React.ComponentType<LiveCardBadgeInfo>;
}) => {
    useUnistyles();
    const navigateToSession = useNavigateToSession();
    const { sessions, workspaces, loaded, stale } = useHomeHerd();
    const lifecycleEvents = useLifecycleEvents();
    const { status: socketStatus } = useSocketStatus();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const { ready, seenEventIds, markSeen } = useActivityAcknowledgements();
    const scrollRef = React.useRef<FlatList<LiveTerminalOrderCard>>(null);
    const scrollXRef = React.useRef(0);
    const [stripWidth, setStripWidth] = React.useState(0);
    const [firstVisible, setFirstVisible] = React.useState(0);
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => setStripWidth(event.nativeEvent.layout.width), []);
    // The next card always shows a hand's width: on a 270pt phone a 240 floor
    // left a 2pt sliver that read as a rendering fault, not as more to swipe.
    const cardWidth = Math.min(CARD_WIDTH, Math.max(200, stripWidth - STRIP_GUTTER - 24));
    const cardInterval = cardWidth + CARD_GAP;
    const getItemLayout = React.useCallback((_: ArrayLike<LiveTerminalOrderCard> | null | undefined, index: number) => ({
        length: cardInterval,
        offset: cardInterval * index,
        index,
    }), [cardInterval]);
    // The same agents the Spaces count and the badge count: a row leaves when
    // its agent stops needing you, never because its card was glanced at.
    const needsYou = useHomeNeedsYouIds();
    const panes = React.useMemo(
        () => herdPanes(sessions, workspaces),
        [sessions, workspaces],
    );
    const candidateCards = React.useMemo(
        () => selectLiveTerminalCards(sessions, panes),
        [panes, sessions],
    );
    // Bumped when a deferred reorder or a working agent's dwell comes due.
    const [orderTick, setOrderTick] = React.useState(0);
    const bumpOrder = React.useCallback(() => setOrderTick((tick) => tick + 1), []);
    // orderTick only asks for the arrangement to be read again at a new time.
    const cards = React.useMemo(() => sharedLiveTerminalCards(candidateCards), [candidateCards, orderTick]);
    React.useEffect(() => subscribeLiveTerminalOrder(bumpOrder), [bumpOrder]);
    React.useEffect(() => {
        const settlesAt = sharedLiveTerminalOrderSettlesAt();
        if (settlesAt === undefined) return;
        const timer = setTimeout(bumpOrder, Math.max(0, settlesAt - Date.now()));
        return () => clearTimeout(timer);
    }, [bumpOrder, cards, orderTick]);
    // Hold the order while a finger is on the strip and for a grace after.
    const touchingRef = React.useRef(false);
    const releaseHoldRef = React.useRef<(() => void) | null>(null);
    const graceTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const noteInteraction = React.useCallback(() => {
        releaseHoldRef.current ??= holdLiveTerminalOrder();
        clearTimeout(graceTimerRef.current);
        if (touchingRef.current) return;
        graceTimerRef.current = setTimeout(() => {
            releaseHoldRef.current?.();
            releaseHoldRef.current = null;
        }, REORDER_GRACE_MS);
    }, []);
    const touchStart = React.useCallback(() => { touchingRef.current = true; noteInteraction(); }, [noteInteraction]);
    const touchEnd = React.useCallback(() => { touchingRef.current = false; noteInteraction(); }, [noteInteraction]);
    React.useEffect(() => () => {
        clearTimeout(graceTimerRef.current);
        releaseHoldRef.current?.();
    }, []);
    const liveTitles = React.useMemo(() => {
        const titles = new Map<string, string>();
        for (const pane of panes) {
            if (pane.taskTitle !== undefined && pane.taskTitle !== '') titles.set(pane.id, pane.taskTitle);
        }
        return titles;
    }, [panes]);
    // Ages are read against a minute that ticks, so a card that says
    // "Working · 4m" does not stay at 4m while nothing else changes.
    const [minute, setMinute] = React.useState(Date.now);
    React.useEffect(() => {
        const timer = setInterval(() => setMinute(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);
    // An event keeps the name the agent had then; a rename since should read here too.
    const liveNames = React.useMemo(
        () => new Map(panes.flatMap((pane) => pane.agentName ? [[pane.id, pane.agentName] as const] : [])),
        [panes],
    );
    const unseenRows = React.useCallback((wanted: (row: RecentActivityRow) => boolean) => {
        if (!ready) return [];
        return unseenActivityRows(lifecycleEvents, seenEventIds, Date.now(), 8, liveTitles, wanted)
            .map((row) => ({ ...row, agentName: liveNames.get(row.sessionId) ?? row.agentName }));
    }, [lifecycleEvents, liveNames, liveTitles, ready, seenEventIds]);
    const needsYouRows = React.useMemo(
        () => needsYouActivityRows(needsYou, panes, lifecycleEvents),
        [lifecycleEvents, needsYou, panes],
    );
    // A failure whose agent has left the tree (could not start) has no status
    // left to read, so it stays an unseen notice until opened. Until the tree
    // loads every agent looks gone, so no failure reads as departed yet.
    const paneIds = React.useMemo(() => new Set(panes.map((pane) => pane.id)), [panes]);
    const departedRows = React.useMemo(
        () => loaded
            ? unseenRows((row) => row.status === 'failed' && !paneIds.has(row.sessionId) && !needsYou.has(row.sessionId))
            : [],
        [loaded, needsYou, paneIds, unseenRows],
    );
    // Done is an outcome, not activity: it gets its own READY · UNSEEN tier and
    // clears when the agent is opened (TerminalRoute acks), never by the card
    // scrolling past on Home.
    const readyRows = React.useMemo(
        () => unseenRows((row) => row.status === 'done'),
        [unseenRows],
    );
    // The card highlight set IS the tier, so a card and the tier can never
    // disagree about which finished outcomes are still unopened.
    const readySessionIds = React.useMemo(
        () => new Set(readyRows.map((row) => row.sessionId)),
        [readyRows],
    );

    const attentionIndex = cards.findIndex((card) => liveTerminalBucket(card.agentStatus, card.pendingRequest) === 'attention');
    const commitVisibleIndex = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const x = event.nativeEvent.contentOffset.x;
        scrollXRef.current = x;
        noteInteraction();
        setFirstVisible((current) => {
            const next = Math.max(0, Math.floor(x / cardInterval));
            return next === current ? current : next;
        });
    }, [cardInterval, noteInteraction]);
    // At the head of the strip the head is what the user reads, so the new
    // order shows there. Scrolled in, the card they were reading stays put.
    const atHead = scrollXRef.current < cardInterval / 2;
    const anchorIdRef = React.useRef<string | undefined>(undefined);
    React.useLayoutEffect(() => {
        const anchorId = anchorIdRef.current;
        const anchorIndex = anchorId === undefined ? -1 : cards.findIndex((card) => card.id === anchorId);
        if (!atHead && anchorIndex !== -1 && anchorIndex !== firstVisible) {
            scrollRef.current?.scrollToOffset({ offset: anchorIndex * cardInterval, animated: false });
            scrollXRef.current = anchorIndex * cardInterval;
            setFirstVisible(anchorIndex);
        }
        anchorIdRef.current = cards[anchorIndex === -1 ? firstVisible : anchorIndex]?.id;
    }, [cards]);
    React.useEffect(() => { anchorIdRef.current = cards[firstVisible]?.id; }, [firstVisible]);
    React.useEffect(() => {
        setFirstVisible(Math.max(0, Math.floor(scrollXRef.current / cardInterval)));
    }, [cardInterval]);
    const scrollToCard = React.useCallback((sessionId: string): boolean => {
        const index = cards.findIndex((card) => card.id === sessionId);
        if (index === -1) return false;
        scrollRef.current?.scrollToIndex({ index, animated: true });
        return true;
    }, [cards]);
    const handleScrollToIndexFailed = React.useCallback(({ index }: { index: number }) => {
        scrollRef.current?.scrollToOffset({ offset: index * cardInterval, animated: true });
    }, [cardInterval]);
    const selectActivity = React.useCallback((row: RecentActivityRow) => {
        // Only a departed agent's failure is a notice that opening it reads.
        if (!needsYou.has(row.sessionId)) markSeen([row.eventId]);
        if (!scrollToCard(row.sessionId)) navigateToSession(row.sessionId);
    }, [markSeen, navigateToSession, needsYou, scrollToCard]);
    // Opening the tier row goes straight to the agent; the ack happens on open
    // in TerminalRoute, so every open path clears the tier the same way.
    const openReady = React.useCallback((row: RecentActivityRow) => {
        navigateToSession(row.sessionId);
    }, [navigateToSession]);

    const renderCard = ({ item: card, index }: { item: LiveTerminalOrderCard; index: number }) => (
        <LiveTerminalCard
            card={card}
            events={lifecycleEvents}
            now={minute}
            width={cardWidth}
            height={CARD_HEIGHT}
            // A remembered card has nothing live to show; its preview waits for the host.
            paused={stale || Math.abs(index - firstVisible) > 2}
            disconnected={socketStatus !== 'connected' || stale}
            unseenDone={readySessionIds.has(card.id)}
            canRename={authority === 'control' && !authorityLoading && !stale}
            Badge={cardBadge}
        />
    );

    // With nothing to show and no zero state wanted, there is no section: a
    // lone heading over nothing is the orphan this prop exists to avoid.
    if (cards.length === 0 && !showZeroState && needsYouRows.length === 0 && readyRows.length === 0 && departedRows.length === 0) return null;

    return (
        <View style={stylesheet.strip} onLayout={handleLayout}>
            <View style={stylesheet.header}>
                <SectionLabel>{t('liveTerminals.title')}</SectionLabel>
                {attentionIndex === -1 ? null : (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Show the first agent needing attention"
                        onPress={() => scrollToCard(cards[attentionIndex]!.id)}
                        style={stylesheet.attentionIndicator}
                    >
                        <View style={stylesheet.attentionDot} />
                    </Pressable>
                )}
                {socketStatus === 'connected' ? null : <Text style={stylesheet.reconnecting}>Reconnecting…</Text>}
            </View>
            {cards.length === 0 ? (
                showZeroState ? (
                    <Text style={stylesheet.zeroLine}>{t('homeNotices.liveEmpty')}</Text>
                ) : null
            ) : (
                <View style={{ marginTop: 4 }}>
                <Animated.FlatList
                    ref={scrollRef}
                    data={cards}
                    keyExtractor={(card) => card.id}
                    renderItem={renderCard}
                    getItemLayout={getItemLayout}
                    onScrollToIndexFailed={handleScrollToIndexFailed}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    initialNumToRender={3}
                    maxToRenderPerBatch={6}
                    windowSize={3}
                    onScroll={commitVisibleIndex}
                    scrollEventThrottle={32}
                    onMomentumScrollEnd={commitVisibleIndex}
                    onScrollEndDrag={(event) => { touchingRef.current = false; commitVisibleIndex(event); }}
                    snapToInterval={cardInterval}
                    decelerationRate="fast"
                    ItemSeparatorComponent={() => <View style={{ width: CARD_GAP }} />}
                    contentContainerStyle={{ paddingHorizontal: STRIP_GUTTER }}
                    // Scrolled in, the anchor scroll already keeps the read card still; sliding it too would double the move.
                    itemLayoutAnimation={atHead ? reorderTransition : undefined}
                    onTouchStart={touchStart}
                    onTouchEnd={touchEnd}
                    onTouchCancel={touchEnd}
                    onScrollBeginDrag={touchStart}
                    onMomentumScrollBegin={noteInteraction}
                />
                </View>
            )}
            <RecentActivity
                rows={needsYouRows}
                onSelect={selectActivity}
            />
            <RecentActivity
                rows={readyRows}
                heading="Ready · unseen"
                onSelect={openReady}
            />
            <RecentActivity
                rows={departedRows}
                heading="Could not start"
                onSelect={selectActivity}
            />
        </View>
    );
});
