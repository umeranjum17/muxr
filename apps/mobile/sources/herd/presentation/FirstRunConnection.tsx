import * as React from 'react';
import { Platform, Pressable, Share, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useHostedPairing, usePairQrScanner } from '@/pairing';
import { sshTunnelAvailable } from '@/connection';
import { ActionButton } from '@/components/ActionButton';
import * as Clipboard from 'expo-clipboard';
import { FirstRunSetupCard } from './FirstRunSetupCard';

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
    const scanPairQr = usePairQrScanner((offer) => router.push({ pathname: '/pair', params: { offer } }), !browser);
    // Direct SSH is an Android transport in this codebase; the tile is hidden
    // where the native module is absent rather than offered as a dead choice.
    const sshAvailable = !browser && sshTunnelAvailable();

    const promptForPairingString = React.useCallback(async () => {
        const pasted = await Modal.prompt(
            'Enter pairing string',
            browser
                ? 'Paste the link shown by `muxr pair --browser` for eight hours of control, `muxr pair --browser-personal` for 30 days on a browser only you use, or `muxr pair --browser-view` for view-only access.'
                : 'Paste the pairing string shown by `muxr pair` on the computer.',
            { placeholder: browser ? 'https://your-relay/pair#byokit-link:1:…' : 'byokit-link:1:…' },
        );
        if (!pasted?.trim()) return;
        await processPairLink(pasted.trim());
    }, [browser, processPairLink]);

    return (
        <View style={styles.section}>
            <RouteTile
                title="Scan the QR on your computer"
                badge="Recommended"
                preview="Point this phone at the QR shown by muxr on your computer."
                onPress={() => {
                    if (browser) { void promptForPairingString(); return; }
                    void scanPairQr();
                }}
            />
            {browser ? <FirstRunSetupCard variant="command" /> : (
                <View style={styles.otherWaysBody}>
                    <Text style={styles.routeHint}>On your computer, paste:</Text>
                    <Text style={styles.installCommand} selectable>{INSTALL_COMMAND}</Text>
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
            {!browser && <>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: setupDetailsOpen }}
                    style={styles.setupDetailsToggle} onPress={() => setSetupDetailsOpen((open) => !open)}>
                    <Text style={styles.otherWaysText}>Setup details and guide</Text>
                </Pressable>
                {setupDetailsOpen && <FirstRunSetupCard variant="command" />}
            </>}
            <Text style={styles.otherWaysText}>Other ways to connect</Text>
            <View style={styles.otherWaysBody}>
                <ActionButton variant="secondary" title="Type the pairing code" icon="keypad-outline"
                    action={browser ? promptForPairingString : async () => { router.push('/pair'); }} />
                <Text style={styles.routeHint}>Use this if the computer is not in front of you.</Text>
                {sshAvailable && <>
                    <ActionButton variant="secondary" title="Connect over SSH" icon="terminal-outline" onPress={() => router.push('/pair?route=ssh')} />
                    <Text style={styles.routeHint}>Use this if you already SSH into that computer; no QR needed.</Text>
                </>}
            </View>
            <Text style={styles.footer}>End-to-end encrypted · machine keys never leave your devices</Text>
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
