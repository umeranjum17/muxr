import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { loadAppConfig } from '@/catalog/infrastructure/appConfig';
import { setupEmptyState } from '@/commercialization';
import { openExternalUrl } from '@/utils/openExternalUrl';

/**
 * The three-step first run, shared by the hosted landing and the never-paired
 * Herd: run muxr on the computer, connect this device, review access. Numbered
 * steps, no leading action glyphs; the only compact control is Copy. It carries
 * no pairing buttons (the screen keeps its own) and no progress state.
 */
export function FirstRunSetupCard() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const setup = setupEmptyState(loadAppConfig().publicBaseUrl);
    const [copied, setCopied] = React.useState(false);
    const copy = React.useCallback(() => {
        void Clipboard.setStringAsync(setup.command).then((ok) => {
            if (ok === false) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }).catch(() => {});
    }, [setup.command]);
    return (
        <View style={styles.card}>
            <View style={styles.step}>
                <View style={styles.badge}><Text style={styles.badgeNumber}>1</Text></View>
                <View style={styles.body}>
                    <Text style={styles.stepText}>On your computer</Text>
                    <Text style={styles.stepHint}>Run muxr to review setup</Text>
                    <View style={styles.commandRow}>
                        <Text style={styles.command} selectable>{setup.command}</Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={copied ? 'Copied' : `Copy ${setup.command}`}
                            hitSlop={10}
                            style={styles.copy}
                            onPress={copy}
                        >
                            <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={20} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>
                    {setup.setupUrl !== undefined && (
                        <Pressable accessibilityRole="link" hitSlop={8} onPress={() => void openExternalUrl(setup.setupUrl!)}>
                            <Text style={styles.link}>Not installed? Setup guide</Text>
                        </Pressable>
                    )}
                </View>
            </View>
            <View style={styles.step}>
                <View style={styles.badge}><Text style={styles.badgeNumber}>2</Text></View>
                <View style={styles.body}>
                    <Text style={styles.stepText}>Connect this device</Text>
                    <Text style={styles.stepHint}>Scan the QR or paste its pairing link</Text>
                </View>
            </View>
            <View style={[styles.step, { marginBottom: 0 }]}>
                <View style={styles.badge}><Text style={styles.badgeNumber}>3</Text></View>
                <View style={styles.body}>
                    <Text style={styles.stepText}>Review access</Text>
                    <Text style={styles.stepHint}>Check the computer and access shown, then choose Pair</Text>
                </View>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        width: '100%',
        maxWidth: 360,
        alignSelf: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        padding: 16,
        gap: 16,
    },
    step: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
    },
    badge: {
        width: 24,
        height: 24,
        borderRadius: 999,
        backgroundColor: theme.colors.accentSubtle,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badgeNumber: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
    },
    body: {
        flex: 1,
        gap: 4,
    },
    stepText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    stepHint: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    commandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 2,
    },
    command: {
        ...Typography.mono(),
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        color: theme.colors.text,
    },
    copy: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    link: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.accent,
        marginTop: 2,
    },
}));
