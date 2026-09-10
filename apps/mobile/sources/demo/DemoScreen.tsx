import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { agentLabels, HERD_STATUS_LABELS } from '@/herd/domain/agentPresentation';
import { attentionPresentation } from '@/herd/presentation/attentionPresentation';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { ActionButton } from '@/components/ActionButton';
import { Typography } from '@/constants/Typography';
import { DemoTerminal } from './DemoTerminal';
import { DEMO_AGENTS, DEMO_APPROVAL_REQUEST, DEMO_DONE_PATCH, DEMO_INSTALL_COMMAND } from './demoFixtures';

/**
 * Deterministic product replay. Renders recorded fixtures through the real
 * presentation modules — agent labels, status copy, attention presentation,
 * Pierre diff, and an xterm.js terminal (the same stack as TerminalView.web,
 * kept in the platform-split DemoTerminal so native bundling never sees
 * xterm). No backend, no network beyond static assets, no
 * Add-to-Home-Screen prompt.
 */

type Phase = 'loop' | 'request' | 'continuing' | 'done';

function AgentCard({
    index, selected, onSelect,
}: {
    index: number; selected: boolean; onSelect: () => void;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const agent = DEMO_AGENTS[index]!;
    const labels = agentLabels(agent);
    const status = HERD_STATUS_LABELS[agent.agentStatus] ?? agent.agentStatus;
    let attention = null;
    if (agent.agentStatus === 'blocked') attention = attentionPresentation('blocked', theme);
    if (agent.agentStatus === 'done') attention = attentionPresentation('done', theme);
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[styles.card, selected && styles.cardSelected]}
            onPress={onSelect}
        >
            <View style={styles.cardHead}>
                <Text style={styles.agentName}>{labels.taskTitle}</Text>
                {attention && (
                    <View style={[styles.badge, { borderColor: attention.color }]}>
                        <Ionicons name={attention.icon} size={12} color={attention.color} />
                        <Text style={[styles.badgeText, { color: attention.color }]}>{attention.label}</Text>
                    </View>
                )}
            </View>
            <Text style={styles.agentSub}>{labels.agentName} · {status}</Text>
        </Pressable>
    );
}

export function DemoScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [selected, setSelected] = React.useState(1);
    const [phase, setPhase] = React.useState<Phase>('loop');
    const [copied, setCopied] = React.useState(false);
    const agent = DEMO_AGENTS[selected]!;
    const isBlocked = selected === 1;
    const continued = phase === 'continuing' || phase === 'done';
    const lines = isBlocked && continued ? [...agent.transcript, ...agent.continuation] : agent.transcript;

    const approve = React.useCallback(() => {
        setPhase('continuing');
        setTimeout(() => setPhase('done'), agent.continuation.length * 350 + 400);
    }, [agent.continuation.length]);

    const copyInstall = React.useCallback(async () => {
        await Clipboard.setStringAsync(DEMO_INSTALL_COMMAND);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, []);

    return (
        <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
            <View style={styles.replayBadge}>
                <Ionicons name="play-circle-outline" size={14} color={theme.colors.textSecondary} />
                <Text style={styles.replayText}>Demo replay — deterministic, no backend</Text>
            </View>
            <Text style={styles.title}>Answer a blocked agent from anywhere</Text>
            <Text style={styles.subtitle}>One working, one done, one blocked. Inspect the blocked request, approve it, watch it finish.</Text>

            {DEMO_AGENTS.map((entry, index) => (
                <AgentCard key={entry.paneId} index={index} selected={index === selected} onSelect={() => setSelected(index)} />
            ))}

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Terminal — {agentLabels(agent).agentName}</Text>
                <DemoTerminal key={agent.paneId} lines={lines} live={continued || agent.agentStatus === 'working'} />
            </View>

            {isBlocked && phase === 'loop' && (
                <ActionButton title="Inspect blocked request" icon="search-outline" onPress={() => setPhase('request')} />
            )}
            {isBlocked && phase === 'request' && (
                <View style={styles.request}>
                    <Text style={styles.sectionTitle}>Approval requested</Text>
                    <Text style={styles.command}>{DEMO_APPROVAL_REQUEST.command}</Text>
                    <Text style={styles.requestReason}>{DEMO_APPROVAL_REQUEST.reason}</Text>
                    <ActionButton title="Approve and continue" icon="checkmark-outline" onPress={approve} />
                </View>
            )}
            {isBlocked && phase === 'continuing' && (
                <Text style={styles.progress}>Approved — Bex is continuing…</Text>
            )}
            {isBlocked && phase === 'done' && (
                <View style={styles.request}>
                    <View style={[styles.badge, { borderColor: theme.colors.success }]}>
                        <Ionicons name="checkmark-circle" size={12} color={theme.colors.success} />
                        <Text style={[styles.badgeText, { color: theme.colors.success }]}>Done</Text>
                    </View>
                    <Text style={styles.sectionTitle}>Artifact</Text>
                    <PierreDiffView patch={DEMO_DONE_PATCH} overflow="wrap" />
                </View>
            )}
            {selected === 2 && (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Artifact</Text>
                    <PierreDiffView patch={DEMO_DONE_PATCH} overflow="wrap" />
                </View>
            )}

            <View style={styles.cta}>
                <Text style={styles.sectionTitle}>That was a replay. Your agents, 5 minutes:</Text>
                <Text style={styles.command}>{DEMO_INSTALL_COMMAND}</Text>
                <ActionButton title={copied ? 'Copied' : 'Copy install command'} icon="copy-outline" onPress={() => void copyInstall()} />
                <Text style={styles.subtitle}>Then run `muxr` and pair this browser — install the app after pairing, never this demo page.</Text>
            </View>
        </ScrollView>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface },
    content: { padding: 20, gap: 12, paddingBottom: 48, maxWidth: 640, width: '100%', alignSelf: 'center' },
    replayBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    replayText: { ...Typography.default(), fontSize: 12, color: theme.colors.textSecondary },
    title: { ...Typography.default('semiBold'), fontSize: 24, lineHeight: 30, color: theme.colors.text },
    subtitle: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
    card: { backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 14, padding: 14, gap: 4 },
    cardSelected: { borderColor: theme.colors.accent },
    cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    agentName: { ...Typography.default('semiBold'), flex: 1, fontSize: 15, color: theme.colors.text },
    agentSub: { ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary },
    badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
    badgeText: { ...Typography.default('semiBold'), fontSize: 12 },
    section: { gap: 8, paddingTop: 8 },
    sectionTitle: { ...Typography.default('semiBold'), fontSize: 13, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.colors.textSecondary },
    request: { backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 14, padding: 14, gap: 10 },
    command: { ...Typography.mono(), fontSize: 14, color: theme.colors.text, backgroundColor: theme.colors.surfaceHighest, borderRadius: 8, padding: 10 },
    requestReason: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.text },
    progress: { ...Typography.default(), fontSize: 14, color: theme.colors.textSecondary },
    cta: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.divider, marginTop: 8 },
}));
