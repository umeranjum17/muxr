import * as React from 'react';
import { AppState, type FlatList, Pressable, View, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsFocused } from '@react-navigation/native';
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { Text } from '@/components/StyledText';
import { storage, useHomeHerd, useLifecycleEvents, useSocketStatus } from '@/catalog/store';
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
    visibleActivityEventIds,
    type LiveTerminalOrderCard,
} from '../application/liveTerminalOrder';
import { useActivityAcknowledgements } from '../application/useActivityAcknowledgements';
import { agentLabels, agentNameLine, herdrPaneForSession, isShellLabels, liveCardState } from '../domain/agentPresentation';
import { renamePane, showNameActions } from '../application/renameInHerdr';
import { unseenActivityRows, type RecentActivityRow } from '../domain/recentActivity';
import type { LifecycleEvent } from '@muxr/contract';
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
}

function terminalIsLive(card: LiveTerminalOrderCard): boolean {
    return card.agentStatus === 'working' || card.agentStatus === 'starting' || card.agentStatus === 'blocked';
}

const LiveTerminalCard = React.memo(({ card, events, now, width, height, paused, disconnected, unseenDone, canRename }: CardProps) => {
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const labels = agentLabels(card);
    const dot = agentStatusColor(card.agentStatus, theme);
    const live = terminalIsLive(card);
    const shell = isShellLabels(labels);
    const state = liveCardState(labels, card.agentStatus, card.id, events, now);
    const rename = () => {
        const pane = herdrPaneForSession(storage.getState().herdrWorkspaces, card.id);
        if (pane !== undefined) showNameActions(labels.title, () => void renamePane(pane));
    };
    return (
        <Pressable
            onPress={() => navigateToSession(card.id)}
            onLongPress={canRename ? rename : undefined}
            accessibilityRole="button"
            accessibilityLabel={state.accessibilityLabel}
            style={({ pressed }) => [
                stylesheet.card,
                liveTerminalBucket(card.agentStatus) === 'attention' && stylesheet.attentionCard,
                { width, height, opacity: pressed ? 0.8 : disconnected ? 0.55 : 1 },
            ]}
        >
            <View style={stylesheet.cardBody}>
                <TerminalPreview sessionId={card.id} paused={paused} live={live} dimmed={!live && !unseenDone} />
            </View>
            <View style={stylesheet.cardFooter}>
                <View style={stylesheet.titleRow}>
                    <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={16} />
                    <View style={stylesheet.footerCopy}>
                        <Text numberOfLines={1} style={stylesheet.title}>{labels.title}</Text>
                        <Text numberOfLines={1} style={stylesheet.identity}>{agentNameLine(labels)}</Text>
                    </View>
                    <View style={stylesheet.status}>
                        <Text numberOfLines={1} style={[stylesheet.statusText, { color: dot.color }]}>
                            {state.label}
                        </Text>
                    </View>
                </View>
            </View>
        </Pressable>
    );
});

export const LiveTerminalsRow = React.memo(({
    showZeroState = true,
    visibilityTop,
    visibilityBottomInset = 0,
}: {
    showZeroState?: boolean;
    visibilityTop?: number;
    visibilityBottomInset?: number;
}) => {
    useUnistyles();
    const navigateToSession = useNavigateToSession();
    const screenFocused = useIsFocused();
    const { height: windowHeight } = useWindowDimensions();
    const { sessions, workspaces, stale } = useHomeHerd();
    const lifecycleEvents = useLifecycleEvents();
    const { status: socketStatus } = useSocketStatus();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const { ready, seenEventIds, markSeen } = useActivityAcknowledgements();
    const scrollRef = React.useRef<FlatList<LiveTerminalOrderCard>>(null);
    const stripListRef = React.useRef<View>(null);
    const scrollXRef = React.useRef(0);
    const [foreground, setForeground] = React.useState(AppState.currentState === 'active');
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
    const panes = React.useMemo(() => herdPanes(sessions, workspaces), [sessions, workspaces]);
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
    const activityRows = React.useMemo(() => {
        if (!ready) return [];
        const liveNames = new Map(panes.flatMap((pane) => pane.agentName ? [[pane.id, pane.agentName] as const] : []));
        return unseenActivityRows(lifecycleEvents, seenEventIds, Date.now(), 8, liveTitles)
            .map((row) => ({ ...row, agentName: liveNames.get(row.sessionId) ?? row.agentName }));
    }, [lifecycleEvents, liveTitles, panes, ready, seenEventIds]);
    // Done is an outcome, not activity: it gets its own READY · UNSEEN tier and
    // clears when the agent is opened (TerminalRoute acks), never by the card
    // scrolling past on Home. Needs-you/failed keep the glance-clears rule.
    const needsYouRows = React.useMemo(
        () => activityRows.filter((row) => row.status !== 'done'),
        [activityRows],
    );
    const readyRows = React.useMemo(
        () => activityRows.filter((row) => row.status === 'done'),
        [activityRows],
    );
    // The card highlight set IS the tier, so a card and the tier can never
    // disagree about which finished outcomes are still unopened.
    const readySessionIds = React.useMemo(
        () => new Set(readyRows.map((row) => row.sessionId)),
        [readyRows],
    );

    React.useEffect(() => {
        setForeground(AppState.currentState === 'active');
        const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
        return () => subscription.remove();
    }, []);
    const attentionIndex = cards.findIndex((card) => liveTerminalBucket(card.agentStatus) === 'attention');
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
        markSeen([row.eventId]);
        if (!scrollToCard(row.sessionId)) navigateToSession(row.sessionId);
    }, [markSeen, navigateToSession, scrollToCard]);
    // Opening the tier row goes straight to the agent; the ack happens on open
    // in TerminalRoute, so every open path clears the tier the same way.
    const openReady = React.useCallback((row: RecentActivityRow) => {
        navigateToSession(row.sessionId);
    }, [navigateToSession]);

    React.useEffect(() => {
        if (visibilityTop === undefined || !screenFocused || !foreground) return;
        if (stripWidth <= 0 || needsYouRows.length === 0 || cards.length === 0) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            stripListRef.current?.measureInWindow((_x: number, stripTop: number, _width: number, stripHeight: number) => {
                if (cancelled || AppState.currentState !== 'active') return;
                const eventIds = visibleActivityEventIds(needsYouRows, cards, {
                    focused: screenFocused,
                    foreground,
                    viewportTop: visibilityTop,
                    viewportBottom: windowHeight - visibilityBottomInset,
                    stripTop,
                    stripHeight,
                    scrollX: scrollXRef.current,
                    stripWidth,
                    cardWidth,
                    cardGap: CARD_GAP,
                    gutter: STRIP_GUTTER,
                });
                markSeen(eventIds);
            });
        }, 1000);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [cardWidth, cards, firstVisible, foreground, markSeen, needsYouRows, screenFocused, stripWidth, visibilityBottomInset, visibilityTop, windowHeight]);

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
        />
    );

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
                <View ref={stripListRef} collapsable={false} style={{ marginTop: 4 }}>
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
        </View>
    );
});
