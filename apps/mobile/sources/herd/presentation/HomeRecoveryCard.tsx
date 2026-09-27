import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { cardStyle } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { loadAppConfig } from '@/catalog';

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

export function recoveryMode(error: string | null | undefined, runtimeOffline: boolean): 'host' | 'runtime' | 'update-app' | 'update-host' | 'pair' | 'revoked' {
    if (error?.startsWith('Update needed:')) return /older muxr connection protocol|Update muxr on the computer/i.test(error) ? 'update-host' : 'update-app';
    if (error?.startsWith('Pair again:')) return 'pair';
    if (error?.startsWith('Access removed:')) return 'revoked';
    return runtimeOffline ? 'runtime' : 'host';
}

export function HomeRecoveryCard({
    mode, reason, retrying, feedback, onRetry, onFeedback,
}: {
    mode: ReturnType<typeof recoveryMode>;
    reason?: string | null;
    retrying: boolean;
    feedback: string;
    onRetry: () => void;
    onFeedback: (message: string) => void;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const rePair = mode === 'update-app' || mode === 'update-host' || mode === 'pair' || mode === 'revoked';
    const publicBaseUrl = loadAppConfig().publicBaseUrl;
    const appDownload = Platform.OS === 'ios'
        ? 'https://testflight.apple.com/join/aJSbs8pN'
        : publicBaseUrl ? `${publicBaseUrl}/downloads/stable/android` : 'https://github.com/umeranjum17/muxr/releases/latest';
    return (
        <View style={[styles.card, cardStyle(theme)]}>
            <Text style={styles.title}>{mode === 'update-app' ? 'Update the muxr app' : mode === 'update-host' ? 'Update muxr on your computer' : mode === 'pair' ? 'Pair this phone again' : mode === 'revoked' ? 'Access removed' : mode === 'host' ? 'Computer unreachable' : 'Agent runtime unavailable'}</Text>
            <Text style={styles.body}>
                {mode === 'pair' ? reason?.includes('no longer recognises')
                    ? 'Your computer no longer recognises this phone. Pair once to reconnect.'
                    : 'Your computer has a newer muxr connection. Pair once to reconnect.'
                    : mode === 'update-app' ? 'This app needs an update to connect to your computer.'
                    : mode === 'update-host' ? 'Update muxr on your computer, then pair again.'
                    : mode === 'revoked' ? 'This computer removed your access. Pair again to reconnect.'
                    : reason ?? (mode === 'host'
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
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={mode === 'update-app' ? 'Update app' : mode === 'update-host' ? 'Update computer' : 'Pair again'}
                        onPress={() => mode === 'update-app'
                            ? void openExternalUrl(appDownload)
                            : mode === 'update-host'
                                ? void openExternalUrl(publicBaseUrl ? `${publicBaseUrl}/docs/quickstart` : 'https://github.com/umeranjum17/muxr')
                                : router.push('/pair' as never)}
                        style={[styles.actionTarget, styles.retryButton]}
                    >
                        <Text style={styles.action}>{mode === 'update-app' ? 'Update app' : mode === 'update-host' ? 'Update computer' : 'Pair again'}</Text>
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
            {!rePair && feedback ? <Text accessibilityLiveRegion="polite" style={styles.body}>{feedback}</Text> : null}
        </View>
    );
}
