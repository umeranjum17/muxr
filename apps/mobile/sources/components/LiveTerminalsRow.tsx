/**
 * Moshi-style "Live" strip: the herd's terminals, rendered as actual live
 * terminal thumbnails, horizontally scrollable. Each card watches its pane in
 * observe mode (no takeover, no PTY resize) and shows a status dot + title
 * footer.
 */

import * as React from 'react';
import { Pressable, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { useHerdrTree, useSessions, useSocketStatus } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { agentStatusColor, getSessionName } from '@/utils/sessionUtils';
import { HERD_STATUS_LABELS, sortHerd } from '@/utils/herd';
import { lifecycleTree } from '@/utils/herdTree';
import { selectLiveTerminalCards, useLiveTerminalOrder, type LiveTerminalOrderCard } from '@/utils/liveTerminalOrder';
import { StatusDot } from './StatusDot';
import { TerminalPreview } from '@/terminal/TerminalPreview';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { t } from '@/text';

const MAX_CARDS = 6;
const COMPACT_CARD_WIDTH = 300;
const COMPACT_CARD_HEIGHT = 200;
const CARD_GAP = 12;
const STRIP_GUTTER = 16;

function footerTitle(session: Session): string {
    const metadata = session.metadata;
    if (metadata?.summary?.text.trim()) return getSessionName(session);
    const tab = metadata?.tabLabel?.trim();
    if (tab !== undefined && tab !== '') return tab;
    const path = metadata?.path;
    if (path !== undefined && path.trim() !== '' && path !== '/') return path.split('/').filter(Boolean).pop() ?? path;
    return metadata?.provider?.name ?? 'Agent';
}

const stylesheet = StyleSheet.create((theme) => ({
    strip: {
        paddingVertical: 8,
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: CARD_GAP,
        paddingHorizontal: STRIP_GUTTER,
    },
    zeroState: {
        height: COMPACT_CARD_HEIGHT,
        marginHorizontal: STRIP_GUTTER,
        paddingHorizontal: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    zeroTitle: {
        color: theme.colors.text,
        fontSize: 17,
        fontWeight: '600',
    },
    zeroText: {
        marginTop: 6,
        color: theme.colors.textSecondary,
        fontSize: 13,
        textAlign: 'center',
    },
    label: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.5,
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    card: {
        width: COMPACT_CARD_WIDTH,
        height: COMPACT_CARD_HEIGHT,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    cardBody: {
        flex: 1,
        backgroundColor: '#000',
    },
    cardFooter: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 2,
    },
    footerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
        flexShrink: 1,
    },
    subtitle: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    branch: {
        color: theme.colors.textSecondary,
        fontSize: 10,
        backgroundColor: theme.colors.surface,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
        overflow: 'hidden',
    },
}));

interface LiveTerminalCardProps {
    id: string;
    title: string;
    status: LiveTerminalOrderCard['status'];
    displayName: string;
    kindName: string;
    branch?: string;
    width: number;
    height: number;
}

const LiveTerminalCard = React.memo(({ id, title, status, displayName, kindName, branch, width, height }: LiveTerminalCardProps) => {
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const styles = stylesheet;
    const dot = agentStatusColor(status, theme);

    return (
        <Pressable
            onPress={() => navigateToSession(id)}
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${HERD_STATUS_LABELS[status]}`}
            style={({ pressed }) => [
                styles.card,
                { width, height, opacity: pressed ? 0.85 : 1 },
            ]}
        >
            <View style={styles.cardBody}>
                <TerminalPreview sessionId={id} />
            </View>
            <View style={styles.cardFooter}>
                <View style={styles.footerRow}>
                    <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
                    <Text numberOfLines={1} style={styles.title}>
                        {title}
                    </Text>
                </View>
                <View style={styles.subtitle}>
                    <Text style={{ color: dot.color, fontSize: 11, fontWeight: '600' }}>
                        {HERD_STATUS_LABELS[status]}
                    </Text>
                    <Text
                        numberOfLines={1}
                        style={{ color: theme.colors.textSecondary, fontSize: 11, flexShrink: 1 }}
                    >
                        {displayName} · {kindName}
                        {branch === undefined ? '' : ` · ${branch}`}
                    </Text>
                </View>
            </View>
        </Pressable>
    );
});

export const LiveTerminalsRow = React.memo(({ layout = 'strip' }: { layout?: 'strip' | 'grid' }) => {
    useUnistyles();
    const sessions = useSessions();
    const { workspaces } = useHerdrTree();
    const { status: socketStatus } = useSocketStatus();
    const styles = stylesheet;
    const [stripWidth, setStripWidth] = React.useState(0);
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        setStripWidth(event.nativeEvent.layout.width);
    }, []);
    const stripCardSize = React.useMemo(() => {
        const width = Math.min(COMPACT_CARD_WIDTH, Math.max(240, stripWidth - STRIP_GUTTER - 24));
        return { width, height: COMPACT_CARD_HEIGHT };
    }, [stripWidth]);
    const panes = React.useMemo(
        () => sortHerd(sessions, lifecycleTree(workspaces, socketStatus === 'connected')),
        [sessions, socketStatus, workspaces],
    );
    const cards = React.useMemo(() => selectLiveTerminalCards(sessions, panes), [panes, sessions]);
    const orderedCards = useLiveTerminalOrder(cards).slice(0, MAX_CARDS);
    const gridCardSize = React.useMemo(() => {
        const contentWidth = Math.max(0, stripWidth - STRIP_GUTTER * 2);
        const count = orderedCards.length;
        if (count <= 1) {
            const width = Math.min(contentWidth, 760);
            return { width, height: Math.min(460, Math.max(240, Math.round(width * 0.6))) };
        }
        if (count === 2) {
            const width = Math.floor((contentWidth - CARD_GAP) / 2);
            return { width, height: Math.min(420, Math.max(200, Math.round(width * 0.58))) };
        }
        const columns = Math.max(1, Math.min(4, Math.floor((contentWidth + CARD_GAP) / (320 + CARD_GAP))));
        const width = Math.floor((contentWidth - CARD_GAP * (columns - 1)) / columns);
        return { width, height: Math.min(320, Math.max(180, Math.round(width * 0.62))) };
    }, [orderedCards.length, stripWidth]);

    const cardSize = layout === 'grid' ? gridCardSize : stripCardSize;
    const renderedCards = orderedCards.map(({ session: item, status, title }) => (
        <LiveTerminalCard
            key={item.id}
            id={item.id}
            title={title || footerTitle(item)}
            status={status}
            displayName={item.metadata?.displayName?.trim() || 'Agent'}
            kindName={item.metadata?.provider?.name ?? 'agent'}
            branch={item.metadata?.worktree?.branch}
            width={cardSize.width}
            height={cardSize.height}
        />
    ));

    return (
        <View style={styles.strip} onLayout={handleLayout}>
            <Text style={styles.label}>{t('liveTerminals.title')}</Text>
            {orderedCards.length === 0 ? (
                <View style={styles.zeroState}>
                    <Text style={styles.zeroTitle}>No agents running</Text>
                    <Text style={styles.zeroText}>Start one from New session, or resume a recent session below.</Text>
                </View>
            ) : null}
            {/* .map, not FlatList: virtualization unmounts previews on scroll,
                and each mount spawns a herdr observe subprocess. */}
            {orderedCards.length > 0 && (layout === 'grid' ? (
                <View style={styles.grid}>{renderedCards}</View>
            ) : (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    snapToInterval={stripCardSize.width + CARD_GAP}
                    decelerationRate="fast"
                    contentContainerStyle={{ gap: CARD_GAP, paddingHorizontal: STRIP_GUTTER }}
                >
                    {renderedCards}
                </ScrollView>
            ))}
        </View>
    );
});
