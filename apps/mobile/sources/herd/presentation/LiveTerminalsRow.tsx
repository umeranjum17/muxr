import * as React from 'react';
import { AppState, Pressable, ScrollView, View, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
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
import { agentAccessibilityLabel, agentKindLabel, agentLabels, agentNameLine, agentStateLabel } from '../domain/agentPresentation';
import { unseenActivityRows, type RecentActivityRow } from '../domain/recentActivity';
import { StatusDot } from '@/components/StatusDot';
import { AgentGlyph } from '@/components/AgentGlyph';
import { TerminalPreview } from '@/terminal/ui';
import { useNavigateToSession } from '../application/useNavigateToSession';
import { RecentActivity } from './RecentActivity';

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
    attentionIndicator: { width: 18, height: 28, alignItems: 'center', justifyContent: 'center' },
    attentionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.status.error },
    reconnecting: { marginLeft: 'auto', color: theme.colors.textSecondary, fontSize: 10 },
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
    cardBody: { flex: 1, backgroundColor: '#0c0c0b' },
    endedBody: { opacity: 0.48 },
    cardFooter: { height: 48, paddingHorizontal: 10, paddingVertical: 6, gap: 2 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    title: { flex: 1, color: theme.colors.text, fontSize: 12, lineHeight: 15, fontWeight: '600' },
    kind: { color: theme.colors.textSecondary, fontSize: 9, lineHeight: 12, fontWeight: '600' },
    footerMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    agentName: { flex: 1, color: theme.colors.textSecondary, fontSize: 10, lineHeight: 13 },
    state: { color: theme.colors.textSecondary, fontSize: 10, lineHeight: 13, fontWeight: '600' },
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
    const shell = labels.agentKind === undefined && labels.agentName === 'Shell';
    return (
        <Pressable
            onPress={() => navigateToSession(card.id)}
            accessibilityRole="button"
            accessibilityLabel={shell
                ? `Shell. ${agentStateLabel(card.agentStatus, card.changedAt)}. Terminal`
                : agentAccessibilityLabel(labels, card.agentStatus, card.changedAt)}
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
                    <Text numberOfLines={1} style={stylesheet.title}>{shell ? 'Shell' : labels.taskTitle}</Text>
                    {labels.agentKind !== undefined &&
                        <Text numberOfLines={1} style={stylesheet.kind}>{agentKindLabel(labels.agentKind)}</Text>
                    }
                </View>
                <View style={stylesheet.footerMeta}>
                    <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
                    <Text numberOfLines={1} style={stylesheet.agentName}>{shell ? 'Terminal' : agentNameLine(labels)}</Text>
                    <Text numberOfLines={1} style={stylesheet.state}>
                        {agentStateLabel(card.agentStatus, card.changedAt)}
                    </Text>
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
    const [foreground, setForeground] = React.useState(AppState.currentState === 'active');
    const [stripWidth, setStripWidth] = React.useState(0);
    const [scrollX, setScrollX] = React.useState(0);
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
    const activityRows = React.useMemo(
        () => ready ? unseenActivityRows(lifecycleEvents, seenEventIds) : [],
        [lifecycleEvents, ready, seenEventIds],
    );

    React.useEffect(() => {
        setForeground(AppState.currentState === 'active');
        const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
        return () => subscription.remove();
    }, []);
    const attentionIndex = cards.findIndex((card) => liveTerminalBucket(card.agentStatus) === 'attention');
    const firstVisible = Math.max(0, Math.floor(scrollX / (cardWidth + CARD_GAP)));
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        setScrollX(event.nativeEvent.contentOffset.x);
    }, []);
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
                    scrollX,
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
    }, [activityRows, cardWidth, cards, foreground, markSeen, screenFocused, scrollX, stripWidth, visibilityBottomInset, visibilityTop, windowHeight]);

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
                <Text style={stylesheet.heading}>{t('liveTerminals.title')}</Text>
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
                    <View style={stylesheet.zeroState}>
                        <Text style={stylesheet.zeroText}>No live terminals · Start an agent below</Text>
                    </View>
                ) : null
            ) : (
                <ScrollView
                    ref={scrollRef}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    onScroll={onScroll}
                    scrollEventThrottle={100}
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
