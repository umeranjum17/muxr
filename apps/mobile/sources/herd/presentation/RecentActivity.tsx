import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { SectionLabel, cardStyle } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { agentNameLine, isShellLabels } from '../domain/agentPresentation';
import { compactAge } from '@/utils/compactAge';
import { recentActivityStatus, type RecentActivityRow } from '../domain/recentActivity';
import { AgentGlyph } from '@/components/AgentGlyph';

const COLLAPSED_ROWS = 3;

/**
 * The Needs you / Ready · unseen tiers (design-system home.md §3.6): one card
 * on the spine, rows where the title is the loudest thing and the state is
 * said once — by the heading, or by the row's own status word when failed.
 */
const styles = StyleSheet.create((theme) => ({
    // The same rhythm as the Live strip above: 20pt to the label, 10pt below it.
    section: { marginHorizontal: 16, marginTop: 20 },
    card: { marginTop: 10, overflow: 'hidden' },
    row: {
        minHeight: 52,
        paddingHorizontal: 12,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    copy: { flex: 1, minWidth: 0, gap: 2 },
    task: { color: theme.colors.text, fontSize: 14, lineHeight: 18, ...Typography.default('semiBold') },
    meta: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16, ...Typography.default() },
    more: { minHeight: 38, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
    moreText: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default('semiBold') },
}));

function icon(row: RecentActivityRow): 'checkmark-circle' | 'hand-left' | 'alert-circle' {
    if (row.status === 'done') return 'checkmark-circle';
    if (row.status === 'blocked') return 'hand-left';
    return 'alert-circle';
}

export const RecentActivity = React.memo((props: {
    rows: readonly RecentActivityRow[];
    onSelect: (row: RecentActivityRow) => void;
    heading?: string;
}) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    if (props.rows.length === 0) return null;
    const visible = expanded ? props.rows : props.rows.slice(0, COLLAPSED_ROWS);
    const overflow = Math.max(0, props.rows.length - COLLAPSED_ROWS);

    return (
        <View style={styles.section}>
            <SectionLabel>{props.heading ?? t('recentActivity.needsYou')}</SectionLabel>
            <View style={[styles.card, cardStyle(theme)]}>
                {visible.map((row, index) => {
                    const color = row.status === 'done' ? theme.colors.status.done : theme.colors.status.error;
                    const labels = {
                        taskTitle: row.taskTitle,
                        agentName: row.agentName ?? row.taskTitle,
                        ...(row.agentKind === undefined ? {} : { agentKind: row.agentKind }),
                    };
                    const shell = isShellLabels(labels);
                    const identity = agentNameLine(labels);
                    // The heading already says the state for blocked and done;
                    // only failed rows carry their status word (§3.6).
                    const word = row.status === 'failed' ? recentActivityStatus(row) : undefined;
                    const meta = [identity || undefined, word, compactAge(Date.now() - row.at)].filter(Boolean).join(' · ');
                    const last = index === visible.length - 1 && overflow === 0;
                    return (
                        <Pressable
                            key={row.eventId}
                            accessibilityRole="button"
                            accessibilityLabel={`${row.taskTitle}. ${[identity || undefined, recentActivityStatus(row), compactAge(Date.now() - row.at)].filter(Boolean).join(' · ')}`}
                            onPress={() => props.onSelect(row)}
                            style={({ pressed }) => [styles.row, last && { borderBottomWidth: 0 }, pressed && { opacity: 0.7 }]}
                        >
                            <Ionicons name={icon(row)} size={16} color={color} />
                            <AgentGlyph name={shell ? 'shell' : row.agentKind ?? row.agentName ?? row.taskTitle} size={16} />
                            <View style={styles.copy}>
                                <Text numberOfLines={1} style={styles.task}>{row.taskTitle}</Text>
                                <Text numberOfLines={1} style={styles.meta}>{meta}</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={14} color={theme.colors.groupped.chevron} />
                        </Pressable>
                    );
                })}
                {overflow === 0 ? null : (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={expanded ? t('recentActivity.showLess') : t('recentActivity.showMore', { count: overflow })}
                        onPress={() => setExpanded((current) => !current)}
                        style={({ pressed }) => [styles.more, pressed && { opacity: 0.7 }]}
                    >
                        <Ionicons name={expanded ? 'remove-circle-outline' : 'add-circle-outline'} size={15} color={theme.colors.textSecondary} />
                        <Text style={styles.moreText}>{expanded ? t('recentActivity.showLess') : t('recentActivity.showMore', { count: overflow })}</Text>
                    </Pressable>
                )}
            </View>
        </View>
    );
});
