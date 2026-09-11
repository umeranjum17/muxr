import * as React from 'react';
import { AppState, Platform, Pressable, ScrollView, View, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsFocused } from '@react-navigation/native';
import { Text } from '@/components/StyledText';
import { useHerdrTree, useLifecycleEvents, useSessions, useSocketStatus } from '@/catalog/store';
import { t } from '@/text';
import { agentStatusColor } from '../application/sessionUtils';
import { herdPanes } from '../domain/herd';
import {
    liveTerminalBucket,
    reconcileLiveTerminalCards,
    selectLiveTerminalCards,
    visibleActivityEventIds,
    type LiveTerminalOrderCard,
} from '../application/liveTerminalOrder';
import { useActivityAcknowledgements } from '../application/useActivityAcknowledgements';
import { agentAccessibilityLabel, agentLabels, agentNameLine, agentStateLabel, isShellLabels } from '../domain/agentPresentation';
import { unseenActivityRows, type RecentActivityRow } from '../domain/recentActivity';
import { AgentGlyph } from '@/components/AgentGlyph';
import { TerminalPreview } from '@/terminal/ui';
import { useNavigateToSession } from '../application/useNavigateToSession';
import { RecentActivity } from './RecentActivity';
import { Typography } from '@/constants/Typography';

const CARD_WIDTH = 300;
const CARD_HEIGHT = 200;
const CARD_GAP = 12;
const STRIP_GUTTER = 16;

const stylesheet = StyleSheet.create((theme) => ({
    strip: { paddingVertical: 6 },
    header: {
        minHeight: 40,
        paddingHorizontal: STRIP_GUTTER,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    heading: { color: theme.colors.groupped.sectionTitle, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
    // 44px box inside a shorter caption row: the negative margin keeps the row height.
    // A word beside the dot: colour never carries the state alone.
    attentionIndicator: { minWidth: 44, height: 44, marginVertical: -8, marginLeft: -6, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
    attentionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.status.error },
    attentionText: { ...Typography.default('semiBold'), fontSize: 11, color: theme.colors.status.error },
    zeroState: {
        height: 96,
        marginHorizontal: STRIP_GUTTER,
        paddingHorizontal: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    zeroText: { color: theme.colors.textSecondary, fontSize: 13 },
    card: {
        height: CARD_HEIGHT,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    attentionCard: { borderWidth: 1.5, borderColor: theme.colors.status.error },
    cardBody: { flex: 1, backgroundColor: theme.colors.terminal.background },
    endedBody: { opacity: 0.48 },
    cardFooter: { minHeight: 48, paddingHorizontal: 10, paddingVertical: 6 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    footerCopy: { flex: 1, minWidth: 0, gap: 2 },
    title: { color: theme.colors.text, fontSize: 12, lineHeight: 15, fontWeight: '600' },
    identity: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 14 },
    status: {
        flexShrink: 0,
        marginLeft: 8,
    },
    statusText: { fontSize: 11, lineHeight: 14, fontVariant: ['tabular-nums'] },
}));

interface CardProps {
    card: LiveTerminalOrderCard;
    width: number;
    height: number;
    paused: boolean;
    disconnected: boolean;
}

function terminalIsLive(card: LiveTerminalOrderCard): boolean {
    return card.agentStatus === 'working' || card.agentStatus === 'starting' || card.agentStatus === 'blocked';
}

const LiveTerminalCard = React.memo(({ card, width, height, paused, disconnected }: CardProps) => {
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const labels = agentLabels(card);
    const dot = agentStatusColor(card.agentStatus, theme);
    const live = terminalIsLive(card);
    const shell = isShellLabels(labels);
    return (
        <Pressable
            onPress={() => navigateToSession(card.id)}
            accessibilityRole="button"
            accessibilityLabel={agentAccessibilityLabel(labels, card.agentStatus, card.changedAt)}
            style={({ pressed }) => [
                stylesheet.card,
                liveTerminalBucket(card.agentStatus) === 'attention' && stylesheet.attentionCard,
                { width, height, opacity: pressed ? 0.8 : disconnected ? 0.55 : 1 },
            ]}
        >
            <View style={[stylesheet.cardBody, !live && stylesheet.endedBody]}>
                <TerminalPreview sessionId={card.id} paused={paused} live={live} />
            </View>
            <View style={stylesheet.cardFooter}>
                <View style={stylesheet.titleRow}>
                    <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={16} />
                    <View style={stylesheet.footerCopy}>
                        <Text numberOfLines={1} style={stylesheet.title}>{labels.taskTitle}</Text>
                        <Text numberOfLines={1} style={stylesheet.identity}>{agentNameLine(labels)}</Text>
                    </View>
                    <View style={stylesheet.status}>
                        <Text numberOfLines={1} style={[stylesheet.statusText, { color: dot.color }]}>
                            {agentStateLabel(card.agentStatus, card.changedAt)}
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
    const sessions = useSessions();
    const lifecycleEvents = useLifecycleEvents();
    const { workspaces } = useHerdrTree();
    const { status: socketStatus } = useSocketStatus();
    const { ready, seenEventIds, markSeen } = useActivityAcknowledgements();
    const scrollRef = React.useRef<ScrollView>(null);
    const scrollXRef = React.useRef(0);
    const [foreground, setForeground] = React.useState(AppState.currentState === 'active');
    const [stripWidth, setStripWidth] = React.useState(0);
    const [firstVisible, setFirstVisible] = React.useState(0);
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => setStripWidth(event.nativeEvent.layout.width), []);
    const cardWidth = Math.min(CARD_WIDTH, Math.max(240, stripWidth - STRIP_GUTTER - 24));
    const panes = React.useMemo(() => herdPanes(sessions, workspaces), [sessions, workspaces]);
    const candidateCards = React.useMemo(
        () => selectLiveTerminalCards(sessions, panes),
        [panes, sessions],
    );
    const cardsRef = React.useRef<readonly LiveTerminalOrderCard[]>([]);
    const cards = React.useMemo(() => {
        const next = reconcileLiveTerminalCards(cardsRef.current, candidateCards);
        cardsRef.current = next;
        return next;
    }, [candidateCards]);
    const liveTitles = React.useMemo(() => {
        const titles = new Map<string, string>();
        for (const pane of panes) {
            if (pane.taskTitle !== undefined && pane.taskTitle !== '') titles.set(pane.id, pane.taskTitle);
        }
        return titles;
    }, [panes]);
    const activityRows = React.useMemo(
        () => ready ? unseenActivityRows(lifecycleEvents, seenEventIds, Date.now(), 8, liveTitles) : [],
        [lifecycleEvents, liveTitles, ready, seenEventIds],
    );

    React.useEffect(() => {
        setForeground(AppState.currentState === 'active');
        const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
        return () => subscription.remove();
    }, []);
    const attentionIndex = cards.findIndex((card) => liveTerminalBucket(card.agentStatus) === 'attention');
    const attentionCount = cards.filter((card) => liveTerminalBucket(card.agentStatus) === 'attention').length;
    const commitVisibleIndex = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const x = event.nativeEvent.contentOffset.x;
        scrollXRef.current = x;
        setFirstVisible((current) => {
            const next = Math.max(0, Math.floor(x / (cardWidth + CARD_GAP)));
            return next === current ? current : next;
        });
    }, [cardWidth]);
    React.useEffect(() => {
        setFirstVisible(Math.max(0, Math.floor(scrollXRef.current / (cardWidth + CARD_GAP))));
    }, [cardWidth]);
    const scrollToCard = React.useCallback((sessionId: string): boolean => {
        const index = cards.findIndex((card) => card.id === sessionId);
        if (index === -1) return false;
        scrollRef.current?.scrollTo({ x: index * (cardWidth + CARD_GAP), animated: true });
        return true;
    }, [cardWidth, cards]);
    const selectActivity = React.useCallback((row: RecentActivityRow) => {
        markSeen([row.eventId]);
        if (!scrollToCard(row.sessionId)) navigateToSession(row.sessionId);
    }, [markSeen, navigateToSession, scrollToCard]);

    React.useEffect(() => {
        if (visibilityTop === undefined || !screenFocused || !foreground) return;
        if (stripWidth <= 0 || activityRows.length === 0 || cards.length === 0) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            scrollRef.current?.getNativeScrollRef()?.measureInWindow((_x, stripTop, _width, stripHeight) => {
                if (cancelled || AppState.currentState !== 'active') return;
                const eventIds = visibleActivityEventIds(activityRows, cards, {
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
    }, [activityRows, cardWidth, cards, firstVisible, foreground, markSeen, screenFocused, stripWidth, visibilityBottomInset, visibilityTop, windowHeight]);

    const renderedCards = cards.map((card, index) => (
        <LiveTerminalCard
            key={card.id}
            card={card}
            width={cardWidth}
            height={CARD_HEIGHT}
            paused={Math.abs(index - firstVisible) > 2}
            disconnected={socketStatus !== 'connected'}
        />
    ));

    return (
        <View style={stylesheet.strip} onLayout={handleLayout}>
            <View style={stylesheet.header}>
                <Text accessibilityRole="header" aria-level={2} style={stylesheet.heading}>{t('liveTerminals.title')}</Text>
                {attentionIndex === -1 ? null : (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${attentionCount} need${attentionCount === 1 ? 's' : ''} you. Show the first agent needing attention`}
                        onPress={() => scrollToCard(cards[attentionIndex]!.id)}
                        style={stylesheet.attentionIndicator}
                    >
                        <View style={stylesheet.attentionDot} />
                        <Text style={stylesheet.attentionText}>{`${attentionCount} need${attentionCount === 1 ? 's' : ''} you`}</Text>
                    </Pressable>
                )}
            </View>
            {cards.length === 0 ? (
                showZeroState ? (
                    <View style={stylesheet.zeroState}>
                        <Text style={stylesheet.zeroText}>No live terminals · Start an agent below</Text>
                    </View>
                ) : null
            ) : (
                <ScrollView
                    ref={scrollRef}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    onMomentumScrollEnd={commitVisibleIndex}
                    onScrollEndDrag={commitVisibleIndex}
                    // react-native-web never emits drag/momentum end, so the
                    // browser tracks the visible index from the throttled
                    // scroll stream; the setter is already change-guarded.
                    {...(Platform.OS === 'web' ? { onScroll: commitVisibleIndex, scrollEventThrottle: 100 } : {})}
                    snapToInterval={cardWidth + CARD_GAP}
                    decelerationRate="fast"
                    contentContainerStyle={{ gap: CARD_GAP, paddingHorizontal: STRIP_GUTTER }}
                >
                    {renderedCards}
                </ScrollView>
            )}
            <RecentActivity
                rows={activityRows}
                onSelect={selectActivity}
            />
        </View>
    );
});
