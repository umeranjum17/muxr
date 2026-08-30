import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { agentKindLabel, compactAge } from '../domain/agentPresentation';
import { recentActivityStatus, type RecentActivityRow } from '../domain/recentActivity';
import { AgentGlyph } from '@/components/AgentGlyph';

const COLLAPSED_ROWS = 3;

const styles = StyleSheet.create((theme) => ({
    section: { marginHorizontal: 16, marginVertical: 8, gap: 6 },
    header: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 7 },
    title: {
        color: theme.colors.groupped.sectionTitle,
        fontSize: 11,
        letterSpacing: 1.5,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    card: { borderRadius: 10, backgroundColor: theme.colors.surfaceHigh, overflow: 'hidden' },
    row: {
        minHeight: 52,
        paddingHorizontal: 11,
        paddingVertical: 7,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    copy: { flex: 1, minWidth: 0, gap: 2 },
    taskRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    task: { flex: 1, color: theme.colors.text, fontSize: 12, ...Typography.default('semiBold') },
    kind: { color: theme.colors.textSecondary, fontSize: 9, ...Typography.default('semiBold') },
    meta: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
    more: { minHeight: 38, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
    moreText: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default('semiBold') },
}));

function icon(row: RecentActivityRow): 'checkmark-circle' | 'hand-left' | 'alert-circle' {
    if (row.status === 'done') return 'checkmark-circle';
    if (row.status === 'blocked') return 'hand-left';
    return 'alert-circle';
}

export const RecentActivity = React.memo((props: {
    rows: readonly RecentActivityRow[];
    onSelect: (row: RecentActivityRow) => void;
}) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    if (props.rows.length === 0) return null;
    const visible = expanded ? props.rows : props.rows.slice(0, COLLAPSED_ROWS);
    const overflow = Math.max(0, props.rows.length - COLLAPSED_ROWS);

    return (
        <View style={styles.section}>
            <View style={styles.header}>
                <Text style={styles.title}>While you were away</Text>
            </View>
            <View style={styles.card}>
                {visible.map((row) => {
                    const color = row.status === 'done' ? theme.colors.status.done : theme.colors.status.error;
                    const agentName = row.agentName?.localeCompare(row.taskTitle, undefined, { sensitivity: 'accent' }) === 0
                        ? undefined
                        : row.agentName;
                    const meta = [agentName, recentActivityStatus(row), compactAge(Date.now() - row.at)].filter(Boolean).join(' · ');
                    return (
                        <Pressable
                            key={row.eventId}
                            accessibilityRole="button"
                            accessibilityLabel={`${row.taskTitle}. ${[agentKindLabel(row.agentKind), meta].filter(Boolean).join('. ')}`}
                            onPress={() => props.onSelect(row)}
                            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                        >
                            <Ionicons name={icon(row)} size={16} color={color} />
                            <AgentGlyph name={row.agentName === 'Shell' ? 'shell' : row.agentKind ?? row.agentName ?? row.taskTitle} size={16} />
                            <View style={styles.copy}>
                                <View style={styles.taskRow}>
                                    <Text numberOfLines={1} style={styles.task}>{row.taskTitle}</Text>
                                    {row.agentKind !== undefined &&
                                        <Text numberOfLines={1} style={styles.kind}>{agentKindLabel(row.agentKind)}</Text>
                                    }
                                </View>
                                <Text numberOfLines={1} style={styles.meta}>{meta}</Text>
                            </View>
                            <Ionicons name="arrow-forward" size={14} color={theme.colors.groupped.chevron} />
                        </Pressable>
                    );
                })}
                {overflow === 0 ? null : (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={expanded ? 'Collapse activity' : `Show ${overflow} more changes`}
                        onPress={() => setExpanded((current) => !current)}
                        style={({ pressed }) => [styles.more, pressed && { opacity: 0.7 }]}
                    >
                        <Ionicons name={expanded ? 'remove-circle-outline' : 'add-circle-outline'} size={15} color={theme.colors.textSecondary} />
                        <Text style={styles.moreText}>{expanded ? 'Show less' : `+${overflow} more changes`}</Text>
                    </Pressable>
                )}
            </View>
        </View>
    );
});
