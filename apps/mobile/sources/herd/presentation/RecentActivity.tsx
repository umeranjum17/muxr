import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentLifecycle } from '@muxr/contract';
import { Text } from '@/components/StyledText';
import { useLifecycleEvents } from '@/catalog/store';
import { Typography } from '@/constants/Typography';

const labels: Record<AgentLifecycle, string> = {
    starting: 'Starting',
    working: 'Working',
    blocked: 'Needs attention',
    done: 'Finished',
    failed: 'Failed',
    idle: 'Waiting',
    unknown: 'Status unknown',
};

function activityLabel(event: { state: AgentLifecycle; reasonCode: string }): string {
    if (event.state === 'failed' && (
        event.reasonCode === 'start-launch-failed'
        || event.reasonCode === 'start-timeout'
        || event.reasonCode === 'squad-rolled-back'
        || event.reasonCode === 'agent-unavailable'
    )) return 'Could not start';
    return labels[event.state];
}

function shortTime(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const styles = StyleSheet.create((theme) => ({
    section: {
        marginHorizontal: 16,
        marginVertical: 8,
        gap: 6,
    },
    title: {
        color: theme.colors.groupped.sectionTitle,
        fontSize: 12,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    card: {
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 38,
        paddingHorizontal: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    text: {
        flex: 1,
    },
    task: {
        color: theme.colors.text,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    identity: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
    },
    state: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default(),
    },
    time: {
        width: 58,
        textAlign: 'right',
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
    },
}));

export const RecentActivity = React.memo(() => {
    const events = useLifecycleEvents().slice(0, 6);
    if (events.length === 0) return null;
    return (
        <View style={styles.section}>
            <Text style={styles.title}>Recent activity</Text>
            <View style={styles.card}>
                {events.map((event) => (
                    <View key={event.eventId} style={styles.row}>
                        <View style={styles.text}>
                            <Text numberOfLines={1} style={styles.task}>{event.taskTitle?.trim() || 'Current task'}</Text>
                            <Text numberOfLines={1} style={styles.identity}>{event.displayName.trim() || 'Agent'}</Text>
                        </View>
                        <Text numberOfLines={1} style={styles.state}>{activityLabel(event)}</Text>
                        <Text style={styles.time}>{shortTime(event.at)}</Text>
                    </View>
                ))}
            </View>
        </View>
    );
});
