import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { cardStyle } from '@/components/ui';
import { Typography } from '@/constants/Typography';

const HOST_RESTART_COMMAND = 'muxr daemon restart';

const styles = StyleSheet.create((theme) => ({
    card: {
        width: '92%', maxWidth: 800, alignSelf: 'center', marginTop: 12,
        padding: 16, gap: 10,
    },
    title: { color: theme.colors.text, fontSize: 17, ...Typography.default('semiBold') },
    body: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20, ...Typography.default() },
    commandRow: {
        flexDirection: 'row', alignItems: 'center', borderRadius: 10,
        backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider,
        paddingLeft: 12, paddingRight: 6, paddingVertical: 6,
    },
    command: { flex: 1, color: theme.colors.text, fontSize: 14, ...Typography.mono() },
    copy: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
    actionTarget: { minHeight: 44, justifyContent: 'center' },
    retryButton: {
        paddingHorizontal: 14, borderRadius: 10, borderWidth: 1,
        borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSubtle,
    },
    action: { color: theme.colors.accent, fontSize: 14, ...Typography.default('semiBold') },
}));

export function recoveryMode(error: string | null | undefined, runtimeOffline: boolean): 'host' | 'runtime' | 'update' | 'pair' | 'revoked' {
    if (error?.startsWith('Update needed:')) return 'update';
    if (error?.startsWith('Pair again:')) return 'pair';
    if (error?.startsWith('Access removed:')) return 'revoked';
    return runtimeOffline ? 'runtime' : 'host';
}

export function HomeRecoveryCard({
    mode, reason, retrying, feedback, onRetry, onFeedback,
}: {
    mode: 'host' | 'runtime' | 'update' | 'pair' | 'revoked';
    reason?: string | null;
    retrying: boolean;
    feedback: string;
    onRetry: () => void;
    onFeedback: (message: string) => void;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const rePair = mode === 'update' || mode === 'pair' || mode === 'revoked';
    return (
        <View style={[styles.card, cardStyle(theme)]}>
            <Text style={styles.title}>{mode === 'update' ? 'Update needed' : mode === 'pair' ? 'Pair again' : mode === 'revoked' ? 'Access removed' : mode === 'host' ? 'Computer unreachable' : 'Agent runtime unavailable'}</Text>
            <Text style={styles.body}>
                {reason ?? (mode === 'host'
                    ? 'Check that this device can reach the computer and that muxr is running.'
                    : 'The computer is reachable, but its agent runtime is not answering. Restart muxr there.')}
            </Text>
            {!rePair && !reason && <View style={styles.commandRow}>
                <Text selectable style={styles.command}>{HOST_RESTART_COMMAND}</Text>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Copy host restart command"
                    hitSlop={10}
                    style={styles.copy}
                    onPress={() => void Clipboard.setStringAsync(HOST_RESTART_COMMAND)
                        .then(() => onFeedback('Command copied.'))
                        .catch(() => onFeedback('Could not copy. Select the command above.'))}
                >
                    <Ionicons name="copy-outline" size={17} color={theme.colors.textSecondary} />
                </Pressable>
            </View>}
            <View style={styles.actions}>
                {rePair ? (
                    <Pressable accessibilityRole="button" accessibilityLabel="Pair again" onPress={() => router.push('/pair' as never)} style={[styles.actionTarget, styles.retryButton]}>
                        <Text style={styles.action}>Pair again</Text>
                    </Pressable>
                ) : <>
                    <Pressable accessibilityRole="button" accessibilityLabel="Retry connection" disabled={retrying} onPress={onRetry} style={[styles.actionTarget, styles.retryButton]}>
                        <Text style={styles.action}>{retrying ? 'Retrying…' : 'Retry connection'}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="link" onPress={() => router.push('/settings/connection' as never)} style={styles.actionTarget}>
                        <Text style={styles.action}>Connection details</Text>
                    </Pressable>
                </>}
            </View>
            {feedback ? <Text accessibilityLiveRegion="polite" style={styles.body}>{feedback}</Text> : null}
        </View>
    );
}
