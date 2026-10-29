import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { ActionButton } from '@/components/ActionButton';
import { WordWrappingText } from '@/components/WordWrappingText';
import { useCompactWindow } from '@/components/useCompactWindow';
import { Avatar } from '@/components/Avatar';
import { ProviderIcon } from '@/components/ProviderIcon';
import { StatusDot } from '@/components/StatusDot';
import { SectionLabel, cardStyle } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';
import { DEMO_AGENTS, DEMO_COMPUTER, demoAgentStatus, type DemoAgent, type DemoAgentState } from '../domain/demoSeed';

const styles = StyleSheet.create((theme) => ({
    content: {
        flexGrow: 1,
        alignItems: 'center',
        gap: 16,
        paddingTop: 18,
        paddingHorizontal: 16,
        paddingBottom: 32,
    },
    column: { width: '100%', maxWidth: 560, gap: 16 },
    strip: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    pillText: { color: theme.colors.text, fontSize: 12, ...Typography.default('semiBold') },
    demoWhere: { flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13 },
    intro: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20 },
    card: { padding: 0, overflow: 'hidden' },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        minHeight: 72,
    },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    rowBody: { flex: 1, gap: 3 },
    rowTitle: { color: theme.colors.text, fontSize: 16.5, ...Typography.default('semiBold') },
    rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    rowMetaText: { flexShrink: 1, color: theme.colors.textSecondary, fontSize: 12.5 },
    rowStatus: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
    rowStatusText: { flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13 },
    // The dot sits on the first line of a status that wraps on a narrow phone.
    statusDot: { marginTop: 5 },
    back: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, alignSelf: 'flex-start' },
    backText: { color: theme.colors.accent, fontSize: 15, ...Typography.default('semiBold') },
    conversationHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    conversationWho: { flex: 1, gap: 2 },
    conversationName: { color: theme.colors.text, fontSize: 19, ...Typography.default('semiBold') },
    turns: { gap: 12 },
    mine: {
        alignSelf: 'flex-end',
        maxWidth: '84%',
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 20,
        backgroundColor: theme.colors.surfaceHighest,
    },
    mineText: { color: theme.colors.text, fontSize: 15.5, lineHeight: 22 },
    agentText: { color: theme.colors.text, fontSize: 15.5, lineHeight: 22 },
    pairCard: { padding: 16, gap: 10 },
    pairTitle: { color: theme.colors.text, fontSize: 18, ...Typography.default('semiBold') },
    pairBody: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20 },
    pairHint: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
    command: {
        paddingHorizontal: 6,
        borderRadius: 5,
        backgroundColor: theme.colors.surfaceHigh,
        color: theme.colors.text,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
}));

/** Working blue, needs-you red, idle grey: the same hues a live row uses. */
function statusColor(state: DemoAgentState, theme: Theme): string {
    switch (state) {
        case 'needs-you': return theme.colors.status.error;
        case 'working': return theme.colors.status.working;
        default: return theme.colors.status.disconnected;
    }
}

/**
 * The first screen a visitor sees with no computer paired: a sample herd, one
 * of its conversations, and the way into the real pairing flow. Everything it
 * draws comes from `demoSeed`; nothing is fetched or stored.
 */
export function DemoHome({ footer }: { footer?: React.ReactNode } = {}) {
    const { theme } = useUnistyles();
    // At 270 dp and the largest text the pill and computer name already say
    // this is a demo; the sentence would fill the screen before any agent.
    const compact = useCompactWindow();
    const [openId, setOpenId] = React.useState<string | null>(null);
    const open = DEMO_AGENTS.find((agent) => agent.id === openId);

    return (
        <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.column}>
                <View style={styles.strip}>
                    <View style={styles.pill}>
                        <Ionicons name="flask-outline" size={12} color={theme.colors.text} />
                        <Text style={styles.pillText}>Sample data</Text>
                    </View>
                    <Text style={styles.demoWhere}>{DEMO_COMPUTER}</Text>
                </View>

                {open === undefined ? (
                    <>
                        {!compact && (
                            <Text style={styles.intro}>
                                What running your agents from a phone looks like. These agents are a demo, not your computer.
                            </Text>
                        )}
                        <SectionLabel>Agents</SectionLabel>
                        <View style={[styles.card, cardStyle(theme)]}>
                            {DEMO_AGENTS.map((agent, index) => (
                                <DemoAgentRow
                                    key={agent.id}
                                    agent={agent}
                                    first={index === 0}
                                    onPress={() => setOpenId(agent.id)}
                                />
                            ))}
                        </View>
                    </>
                ) : (
                    <DemoConversation agent={open} onBack={() => setOpenId(null)} />
                )}

                <DemoPairStep />
                {footer}
            </View>
        </ScrollView>
    );
}

function DemoAgentRow({ agent, first, onPress }: { agent: DemoAgent; first: boolean; onPress: () => void }) {
    const { theme } = useUnistyles();
    // A 270 dp phone at the largest text has no room for the avatar beside the
    // words; the row keeps them whole instead of sharing the width.
    const compact = useCompactWindow();
    const dot = statusColor(agent.state, theme);
    const status = demoAgentStatus(agent);
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${agent.name}, ${status}. Opens its conversation.`}
            onPress={onPress}
            style={({ pressed }) => [styles.row, !first && styles.rowDivider, { opacity: pressed ? 0.6 : 1 }]}
        >
            {!compact && <Avatar id={agent.avatarId} size={44} />}
            <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>{agent.name}</Text>
                <View style={styles.rowMeta}>
                    <ProviderIcon kind={agent.providerKind} size={12} monochrome />
                    <WordWrappingText fontSize={12.5} style={styles.rowMetaText}>{`${agent.provider} · ${agent.model}`}</WordWrappingText>
                </View>
                <View style={styles.rowStatus}>
                    <StatusDot color={dot} isPulsing={agent.state !== 'idle'} style={styles.statusDot} />
                    <WordWrappingText fontSize={13} style={styles.rowStatusText}>{status}</WordWrappingText>
                </View>
            </View>
            {!compact && <Ionicons name="chevron-forward" size={17} color={theme.colors.textSecondary} />}
        </Pressable>
    );
}

function DemoConversation({ agent, onBack }: { agent: DemoAgent; onBack: () => void }) {
    const { theme } = useUnistyles();
    const compact = useCompactWindow();
    const dot = statusColor(agent.state, theme);
    return (
        <View style={{ gap: 14 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back to all demo agents" onPress={onBack} style={styles.back}>
                <Ionicons name="chevron-back" size={20} color={theme.colors.accent} />
                <Text style={styles.backText}>All agents</Text>
            </Pressable>
            <View style={styles.conversationHead}>
                {!compact && <Avatar id={agent.avatarId} size={44} />}
                <View style={styles.conversationWho}>
                    <WordWrappingText fontSize={19} style={styles.conversationName}>{agent.name}</WordWrappingText>
                    <View style={styles.rowMeta}>
                        <ProviderIcon kind={agent.providerKind} size={12} monochrome />
                        <WordWrappingText fontSize={12.5} style={styles.rowMetaText}>{`${agent.provider} · ${agent.model}`}</WordWrappingText>
                    </View>
                    <View style={styles.rowStatus}>
                        <StatusDot color={dot} isPulsing={agent.state !== 'idle'} style={styles.statusDot} />
                        <WordWrappingText fontSize={13} style={styles.rowStatusText}>{demoAgentStatus(agent)}</WordWrappingText>
                    </View>
                </View>
            </View>
            <View style={styles.turns}>
                {agent.turns.map((turn, index) => turn.from === 'you' ? (
                    <View
                        key={index}
                        accessible
                        accessibilityLabel={`You. ${turn.text}`}
                        style={styles.mine}
                    >
                        <WordWrappingText fontSize={15.5} lineHeight={22} style={styles.mineText}>{turn.text}</WordWrappingText>
                    </View>
                ) : (
                    <WordWrappingText key={index} accessible accessibilityLabel={`Agent. ${turn.text}`} fontSize={15.5} lineHeight={22} style={styles.agentText}>
                        {turn.text}
                    </WordWrappingText>
                ))}
            </View>
        </View>
    );
}

function DemoPairStep() {
    const { theme } = useUnistyles();
    const router = useRouter();
    return (
        <View style={[styles.pairCard, cardStyle(theme)]}>
            <WordWrappingText fontSize={18} style={styles.pairTitle}>Connect your own machine</WordWrappingText>
            <Text style={styles.pairBody}>
                The agents above are a demo in this browser. Connect your computer or a Boat cloud machine and Home shows the agents running there.
            </Text>
            <ActionButton
                title="Connect a machine"
                icon="link-outline"
                wrap
                accessibilityLabel="Connect a machine"
                onPress={() => router.push('/connect')}
            />
            <Text style={styles.pairHint}>
                On your computer, run <Text style={styles.command}>muxr</Text> and paste the link it shows. Cloud setup is in the muxr phone app.
            </Text>
        </View>
    );
}
