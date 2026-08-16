/**
 * Moshi-style "Live" strip: the herd's terminals, rendered as actual live
 * terminal thumbnails, horizontally scrollable. Each card watches its pane in
 * observe mode (no takeover, no PTY resize) and shows a status dot + title
 * footer.
 */

import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
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

const MAX_CARDS = 5;
const CARD_WIDTH = 300;
const CARD_HEIGHT = 200;

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
    label: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.5,
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    card: {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
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
    kindName: string;
    branch?: string;
}

const LiveTerminalCard = React.memo(({ id, title, status, kindName, branch }: LiveTerminalCardProps) => {
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const styles = stylesheet;
    const dot = agentStatusColor(status, theme);

    return (
        <Pressable
            onPress={() => navigateToSession(id)}
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${HERD_STATUS_LABELS[status]}`}
            style={({ pressed }) => [styles.card, { opacity: pressed ? 0.85 : 1 }]}
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
                        {kindName}
                        {branch === undefined ? '' : ` · ${branch}`}
                    </Text>
                </View>
            </View>
        </Pressable>
    );
});

export const LiveTerminalsRow = React.memo(() => {
    useUnistyles();
    const sessions = useSessions();
    const { workspaces } = useHerdrTree();
    const { status: socketStatus } = useSocketStatus();
    const styles = stylesheet;
    const panes = React.useMemo(
        () => sortHerd(sessions, lifecycleTree(workspaces, socketStatus === 'connected')),
        [sessions, socketStatus, workspaces],
    );
    const cards = React.useMemo(() => selectLiveTerminalCards(sessions, panes), [panes, sessions]);
    const orderedCards = useLiveTerminalOrder(cards).slice(0, MAX_CARDS);

    if (orderedCards.length === 0) return null;

    return (
        <View style={styles.strip}>
            <Text style={styles.label}>{t('liveTerminals.title')}</Text>
            {/* .map, not FlatList: virtualization unmounts previews on scroll,
                and each mount spawns a herdr observe subprocess. */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 10, paddingHorizontal: 16 }}
            >
                {orderedCards.map(({ session: item, status }) => (
                    <LiveTerminalCard
                        key={item.id}
                        id={item.id}
                        title={footerTitle(item)}
                        status={status}
                        kindName={item.metadata?.provider?.name ?? 'agent'}
                        branch={item.metadata?.worktree?.branch}
                    />
                ))}
            </ScrollView>
        </View>
    );
});
