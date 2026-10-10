import * as React from 'react';
import { Platform, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { pairingDeviceNoun, pairQrScannerAvailable, useHostedPairing, usePairQrScanner } from '@/pairing';
import { sshTunnelAvailable } from '@/connection';
import { ActionButton } from '@/components/ActionButton';
import * as Clipboard from 'expo-clipboard';
import { FirstRunSetupCard, SetupStep } from './FirstRunSetupCard';

const INSTALL_COMMAND = 'npm install -g --ignore-scripts @trymuxr/cli@latest && muxr';

/**
 * Segmented Fast pairing / Direct SSH switcher. Rendered at the top of the
 * SSH form, so the recommended route stays one tap away even mid-form; the
 * inactive segment is the exit, the active one is a label.
 */
export function RouteSwitcher(props: { onFastPairing: () => void }) {
    const styles = stylesheet;
    return (
        <View style={styles.switcher} accessibilityRole="tablist" accessibilityLabel="Connection route">
            <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: false }}
                style={styles.switcherSegment}
                onPress={props.onFastPairing}
            >
                <Text style={styles.switcherText}>Fast pairing</Text>
            </Pressable>
            <View style={[styles.switcherSegment, styles.switcherSegmentActive]} accessibilityRole="tab" accessibilityState={{ selected: true }}>
                <Text style={[styles.switcherText, styles.switcherTextActive]}>Direct SSH</Text>
            </View>
        </View>
    );
}

function RouteTile(props: {
    title: string;
    badge?: string;
    preview: string;
    onPress: () => void;
}) {
    const styles = stylesheet;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${props.title}${props.badge === undefined ? '' : `. ${props.badge}`}. Steps: ${props.preview}`}
            style={({ pressed }) => [styles.routeTile, pressed && styles.routeTilePressed]}
            onPress={props.onPress}
        >
            <View style={styles.routeTitleRow}>
                <Text style={styles.routeTitle}>{props.title}</Text>
                {props.badge !== undefined && (
                    <View style={styles.routeBadge}>
                        <Text style={styles.routeBadgeText}>{props.badge}</Text>
                    </View>
                )}
            </View>
            <Text style={styles.routePreview}>{props.preview}</Text>
        </Pressable>
    );
}

export function FirstRunConnection() {
    const router = useRouter();
    const styles = stylesheet;
    const [setupDetailsOpen, setSetupDetailsOpen] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    const browser = Platform.OS === 'web';
    const processPairLink = useHostedPairing();
    const canScan = !browser && pairQrScannerAvailable();
    const scanPairQr = usePairQrScanner(processPairLink, canScan);
    // Offer Direct SSH only when this native build includes the transport.
    const sshAvailable = !browser && sshTunnelAvailable();

    const promptForPairingString = React.useCallback(async () => {
        const pasted = await Modal.prompt(
            'Paste the pairing string',
            // Non-breaking spaces keep the command's words together and word
            // joiners bind both hyphens to the flag name, so narrow screens can
            // only wrap before 'muxr' or after '--browser', never mid-flag.
            'Paste the browser link shown by muxr\u00A0pair\u00A0-\u2060-\u2060browser on your computer.',
            { placeholder: 'https://your-relay/pair#…' },
        );
        if (!pasted?.trim()) return;
        await processPairLink(pasted.trim());
    }, [processPairLink]);

    return (
        <View style={styles.section}>
            {browser ? <FirstRunSetupCard variant="command" /> : (
                <View style={styles.otherWaysBody}>
                    <Text style={styles.routeHint}>Step 1 · On your computer, run:</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <Text style={styles.installCommand} numberOfLines={1} selectable>{INSTALL_COMMAND}</Text>
                    </ScrollView>
                    <View style={styles.commandActions}>
                        <ActionButton variant="quiet" title={copied ? 'Copied' : 'Copy'} action={async () => {
                            try {
                                const ok = await Clipboard.setStringAsync(INSTALL_COMMAND);
                                if (ok === false) throw new Error('Could not copy');
                                setCopied(true);
                            } catch {
                                Modal.alert('Copy failed', 'Enter the command shown above on your computer.');
                            }
                        }} />
                        <ActionButton variant="quiet" title="Share" action={async () => {
                            try { await Share.share({ message: INSTALL_COMMAND }); }
                            catch { Modal.alert('Share failed', 'Copy the command instead.'); }
                        }} />
                    </View>
                </View>
            )}
            {browser ? (
                <View style={styles.stepCard}>
                    <SetupStep
                        number={2}
                        title="Paste the browser link"
                        tag="Recommended"
                        hint="Run one command on your computer, then paste the browser pairing link."
                    >
                        <View style={styles.stepAction}>
                            <ActionButton variant="primary" title="Paste the browser link" icon="keypad-outline" wrap action={promptForPairingString} />
                        </View>
                    </SetupStep>
                </View>
            ) : canScan ? (
                <RouteTile
                    title="Step 2 · Scan the QR it shows"
                    badge="Recommended"
                    preview={`Point this ${pairingDeviceNoun()} at the QR shown by muxr on your computer.`}
                    onPress={() => { void scanPairQr(); }}
                />
            ) : (
                <RouteTile
                    title="Step 2 · Paste the pairing string"
                    preview={`This ${pairingDeviceNoun()} can't scan a QR. Copy the string muxr shows on your computer.`}
                    onPress={() => router.push('/pair')}
                />
            )}
            {!browser && <>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: setupDetailsOpen }}
                    style={styles.setupDetailsToggle} onPress={() => setSetupDetailsOpen((open) => !open)}>
                    <Text style={styles.otherWaysText}>Setup details and guide</Text>
                </Pressable>
                {setupDetailsOpen && <FirstRunSetupCard variant="command" />}
                <Text style={styles.otherWaysText}>Other ways to connect</Text>
                <View style={styles.otherWaysBody}>
                    {canScan && <>
                        <ActionButton variant="secondary" title="Paste the pairing string" icon="keypad-outline" wrap
                            action={async () => { router.push('/pair'); }} />
                        <Text style={styles.routeHint}>{`Use this if you can't point this ${pairingDeviceNoun()} at that screen.`}</Text>
                    </>}
                    {sshAvailable && <>
                        <ActionButton variant="secondary" title="Connect over SSH" icon="terminal-outline" onPress={() => router.push('/pair?route=ssh')} />
                        <Text style={styles.routeHint}>Use this if you already SSH into that computer; no QR needed.</Text>
                    </>}
                </View>
            </>}
            <Text style={styles.footer}>End-to-end encrypted</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: 360,
        gap: 12,
    },
    routeTile: {
        width: '100%',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 18,
        gap: 6,
    },
    routeTilePressed: {
        opacity: 0.85,
    },
    stepCard: {
        width: '100%',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 16,
    },
    stepAction: {
        marginTop: 8,
    },
    routeTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
    },
    routeTitle: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        color: theme.colors.text,
    },
    routeBadge: {
        borderRadius: 999,
        backgroundColor: theme.colors.accentSubtle,
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    routeBadgeText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        color: theme.colors.text,
    },
    routePreview: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    switcher: {
        flexDirection: 'row',
        alignSelf: 'stretch',
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 12,
        padding: 3,
        gap: 3,
    },
    switcherSegment: {
        flex: 1,
        height: 40,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    switcherSegmentActive: {
        backgroundColor: theme.colors.surface,
    },
    switcherText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    switcherTextActive: {
        color: theme.colors.text,
    },
    setupDetailsToggle: {
        minHeight: 36,
        justifyContent: 'center',
        alignItems: 'center',
    },
    otherWaysText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    installCommand: {
        ...Typography.mono(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text,
    },
    commandActions: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    otherWaysBody: {
        gap: 8,
        alignItems: 'center',
    },
    footer: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 8,
    },
    routeHint: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));
