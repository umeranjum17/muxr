import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { useLifecycleEvents } from '@/catalog/store';
import { Typography } from '@/constants/Typography';
import { compactAge } from '../domain/agentPresentation';
import { recentActivityRows, recentActivityStatus, type RecentActivityRow } from '../domain/recentActivity';

const VISIBLE_ROWS = 3;

const styles = StyleSheet.create((theme) => ({
    section: {
        marginHorizontal: 16,
        marginVertical: 8,
        gap: 6,
    },
    title: {
        color: theme.colors.groupped.sectionTitle,
        fontSize: 11,
        letterSpacing: 1.5,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    card: {
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        overflow: 'hidden',
    },
    row: {
        minHeight: 34,
        paddingHorizontal: 11,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    task: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    name: {
        maxWidth: 76,
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
    },
    state: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
    time: {
        width: 28,
        textAlign: 'right',
        color: theme.colors.textSecondary,
        fontSize: 10,
        ...Typography.default(),
    },
    footer: {
        minHeight: 44,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    footerText: {
        color: theme.colors.text,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
}));

function icon(row: RecentActivityRow): 'checkmark-circle' | 'hand-left' | 'alert-circle' {
    if (row.status === 'done') return 'checkmark-circle';
    if (row.status === 'blocked') return 'hand-left';
    return 'alert-circle';
}

export const RecentActivity = React.memo(() => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const rows = recentActivityRows(useLifecycleEvents());
    if (rows.length === 0) return null;
    return (
        <View style={styles.section}>
            <Text style={styles.title}>Recent activity</Text>
            <View style={styles.card}>
                {rows.slice(0, VISIBLE_ROWS).map((row) => {
                    const color = row.status === 'done' ? theme.colors.status.done : theme.colors.status.error;
                    return (
                        <View key={row.eventId} style={styles.row}>
                            <Ionicons name={icon(row)} size={15} color={color} />
                            <Text numberOfLines={1} style={styles.task}>{row.taskTitle}</Text>
                            {row.humanName === undefined ? null : <Text numberOfLines={1} style={styles.name}>{row.humanName}</Text>}
                            <Text numberOfLines={1} style={[styles.state, { color }]}>{recentActivityStatus(row)}</Text>
                            <Text style={styles.time}>{compactAge(Date.now() - row.at)}</Text>
                        </View>
                    );
                })}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Show all recent activity"
                    onPress={() => router.push('/session/recent')}
                    style={({ pressed }) => [styles.footer, pressed && { opacity: 0.7 }]}
                >
                    <Ionicons name="time-outline" size={15} color={theme.colors.textSecondary} />
                    <Text style={styles.footerText}>{rows.length > VISIBLE_ROWS ? 'Show all activity' : 'Session history'}</Text>
                    <Ionicons name="chevron-forward" size={14} color={theme.colors.groupped.chevron} style={{ marginLeft: 'auto' }} />
                </Pressable>
            </View>
        </View>
    );
});
