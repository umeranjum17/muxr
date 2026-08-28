import * as React from 'react';
import { Pressable, ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { useHerdrTree, useSessions, useSocketStatus } from '@/catalog/store';
import { agentStatusColor } from '../application/sessionUtils';
import { HERD_STATUS_LABELS, sortHerd } from '../domain/herd';
import { lifecycleTree } from '../domain/herdTree';
import {
    liveTerminalBucket,
    orderLiveTerminalCards,
    selectLiveTerminalCards,
    type LiveTerminalOrderCard,
} from '../application/liveTerminalOrder';
import { agentAccessibilityLabel, agentLabels, compactAge } from '../domain/agentPresentation';
import { StatusDot } from '@/components/StatusDot';
import { TerminalPreview } from '@/terminal/ui';
import { useNavigateToSession } from '../application/useNavigateToSession';

const MAX_CARDS = 12;
const LIVE_CARD_WIDTH = 208;
const DONE_CARD_WIDTH = 132;
const CARD_HEIGHT = 152;
const CARD_GAP = 10;
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
    segment: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' },
    segmentStrong: { color: theme.colors.text },
    reconnecting: { marginLeft: 'auto', color: theme.colors.textSecondary, fontSize: 10 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: CARD_GAP, paddingHorizontal: STRIP_GUTTER },
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
    cardFooter: { height: 48, paddingHorizontal: 9, paddingVertical: 6, gap: 2 },
    footerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    title: { color: theme.colors.text, fontSize: 12, lineHeight: 15, fontWeight: '600', flexShrink: 1 },
    subtitle: { color: theme.colors.textSecondary, fontSize: 10, lineHeight: 13 },
    doneBody: { flex: 1, padding: 11, justifyContent: 'center', gap: 8 },
    doneTitle: { color: theme.colors.text, fontSize: 12, lineHeight: 16, fontWeight: '600' },
    more: {
        width: DONE_CARD_WIDTH,
        height: CARD_HEIGHT,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    moreText: { color: theme.colors.text, fontSize: 13, fontWeight: '600' },
}));

interface CardProps {
    card: LiveTerminalOrderCard;
    width: number;
    height: number;
    paused: boolean;
    showProvider: boolean;
    disconnected: boolean;
}

const LiveTerminalCard = React.memo(({ card, width, height, paused, showProvider, disconnected }: CardProps) => {
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const labels = agentLabels(undefined, card.session);
    const dot = agentStatusColor(card.status, theme);
    const done = card.status === 'done';
    const doneAge = compactAge(Date.now() - card.changedAt);
    const doneTime = doneAge === 'now' ? 'just now' : `${doneAge} ago`;
    const details = [labels.humanName, showProvider ? labels.providerKind : undefined, labels.context].filter(Boolean).join(' · ');

    return (
        <Pressable
            onPress={() => navigateToSession(card.session.id)}
            accessibilityRole="button"
            accessibilityLabel={agentAccessibilityLabel(labels, card.status, card.changedAt)}
            style={({ pressed }) => [
                stylesheet.card,
                liveTerminalBucket(card.status) === 'attention' && stylesheet.attentionCard,
                { width, height, opacity: pressed ? 0.8 : disconnected ? 0.55 : 1 },
            ]}
        >
            {done ? (
                <View style={stylesheet.doneBody}>
                    <Ionicons name="checkmark-circle" size={20} color={theme.colors.status.done} />
                    <Text numberOfLines={3} style={stylesheet.doneTitle}>{labels.taskTitle}</Text>
                    <Text numberOfLines={1} style={stylesheet.subtitle}>
                        {[labels.humanName, doneTime].filter(Boolean).join(' · ')}
                    </Text>
                </View>
            ) : (
                <>
                    <View style={stylesheet.cardBody}>
                        <TerminalPreview sessionId={card.session.id} paused={paused} />
                    </View>
                    <View style={stylesheet.cardFooter}>
                        <View style={stylesheet.footerRow}>
                            <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
                            <Text numberOfLines={1} style={stylesheet.title}>{labels.taskTitle}</Text>
                        </View>
                        <Text numberOfLines={1} style={[stylesheet.subtitle, { color: dot.color }]}>
                            {HERD_STATUS_LABELS[card.status]}{details === '' ? '' : ` · ${details}`}
                        </Text>
                    </View>
                </>
            )}
        </Pressable>
    );
});

export const LiveTerminalsRow = React.memo(({ layout = 'strip' }: { layout?: 'strip' | 'grid' }) => {
    useUnistyles();
    const router = useRouter();
    const sessions = useSessions();
    const { workspaces } = useHerdrTree();
    const { status: socketStatus } = useSocketStatus();
    const [stripWidth, setStripWidth] = React.useState(0);
    const [scrollX, setScrollX] = React.useState(0);
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => setStripWidth(event.nativeEvent.layout.width), []);
    const panes = React.useMemo(() => sortHerd(sessions, lifecycleTree(workspaces)), [sessions, workspaces]);
    const allCards = React.useMemo(
        () => orderLiveTerminalCards(selectLiveTerminalCards(sessions, panes)),
        [panes, sessions],
    );
    const cards = allCards.slice(0, MAX_CARDS);
    const overflow = Math.max(0, allCards.length - cards.length);
    const providerCount = new Set(cards.map((card) => agentLabels(undefined, card.session).providerKind).filter(Boolean)).size;
    const counts = cards.reduce((result, card) => {
        result[liveTerminalBucket(card.status)] += 1;
        return result;
    }, { attention: 0, working: 0, settled: 0, offline: 0 });
    const firstVisible = Math.max(0, Math.floor(scrollX / (LIVE_CARD_WIDTH + CARD_GAP)));
    const gridCardSize = React.useMemo(() => {
        const contentWidth = Math.max(0, stripWidth - STRIP_GUTTER * 2);
        const columns = Math.max(1, Math.min(4, Math.floor((contentWidth + CARD_GAP) / (280 + CARD_GAP))));
        const width = Math.floor((contentWidth - CARD_GAP * (columns - 1)) / columns);
        return { width, height: Math.max(180, Math.round(width * 0.62)) };
    }, [stripWidth]);
    const snapToOffsets = React.useMemo(() => {
        let offset = 0;
        return cards.map((card) => {
            const current = offset;
            offset += (card.status === 'done' ? DONE_CARD_WIDTH : LIVE_CARD_WIDTH) + CARD_GAP;
            return current;
        });
    }, [cards]);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        setScrollX(event.nativeEvent.contentOffset.x);
    }, []);

    const renderedCards = cards.map((card, index) => {
        let width = gridCardSize.width;
        if (layout === 'strip') width = card.status === 'done' ? DONE_CARD_WIDTH : LIVE_CARD_WIDTH;
        const height = layout === 'grid' ? gridCardSize.height : CARD_HEIGHT;
        return (
            <LiveTerminalCard
                key={card.session.id}
                card={card}
                width={width}
                height={height}
                paused={layout === 'strip' && Math.abs(index - firstVisible) > 2}
                showProvider={providerCount > 1}
                disconnected={socketStatus !== 'connected'}
            />
        );
    });

    return (
        <View style={stylesheet.strip} onLayout={handleLayout}>
            <View style={stylesheet.header}>
                <Text style={stylesheet.heading}>AGENTS</Text>
                <Text style={[stylesheet.segment, counts.attention > 0 && stylesheet.segmentStrong]}>Needs you {counts.attention}</Text>
                <Text style={[stylesheet.segment, counts.working > 0 && stylesheet.segmentStrong]}>Working {counts.working}</Text>
                <Text style={[stylesheet.segment, counts.settled > 0 && stylesheet.segmentStrong]}>Done {counts.settled}</Text>
                {socketStatus === 'connected' ? null : <Text style={stylesheet.reconnecting}>Reconnecting…</Text>}
            </View>
            {cards.length === 0 ? (
                <View style={stylesheet.zeroState}>
                    <Text style={stylesheet.zeroText}>No agents running · Start one below</Text>
                </View>
            ) : layout === 'grid' ? (
                <View style={stylesheet.grid}>{renderedCards}</View>
            ) : (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    onScroll={onScroll}
                    scrollEventThrottle={100}
                    snapToOffsets={snapToOffsets}
                    decelerationRate="fast"
                    contentContainerStyle={{ gap: CARD_GAP, paddingHorizontal: STRIP_GUTTER }}
                >
                    {renderedCards}
                    {overflow === 0 ? null : (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Show ${overflow} more agents`}
                            onPress={() => router.push('/session/recent')}
                            style={({ pressed }) => [stylesheet.more, pressed && { opacity: 0.75 }]}
                        >
                            <Ionicons name="ellipsis-horizontal-circle" size={22} />
                            <Text style={stylesheet.moreText}>+{overflow} more</Text>
                        </Pressable>
                    )}
                </ScrollView>
            )}
        </View>
    );
});
