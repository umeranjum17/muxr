import * as React from 'react';
import { Platform, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { pairingDeviceNoun, usePairQrScannerAvailable, useHostedPairing, usePairQrScanner } from '@/pairing';
import { sshTunnelAvailable } from '@/connection';
import { ActionButton } from '@/components/ActionButton';
import { FirstRunSetupCard } from './FirstRunSetupCard';

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

// Paste and Scan share the existing validator and consent route; this shell
// does not claim an offer or store a grant.
export function FirstRunConnection() {
    const router = useRouter();
    const styles = stylesheet;
    const { width, fontScale } = useWindowDimensions();
    const compact = width / fontScale < 200;
    const [linkValue, setLinkValue] = React.useState('');
    const [moreWaysOpen, setMoreWaysOpen] = React.useState(false);
    const browser = Platform.OS === 'web';
    const processPairLink = useHostedPairing();
    const canScan = usePairQrScannerAvailable();
    const scanPairQr = usePairQrScanner(processPairLink, canScan);
    // Offer Direct SSH only when this native build includes the transport.
    const sshAvailable = !browser && sshTunnelAvailable();
    const connectLink = React.useCallback(() => {
        void processPairLink(linkValue.trim());
    }, [processPairLink, linkValue]);

    return (
        <View style={styles.section}>
            <View style={styles.intro}>
                <Text style={styles.eyebrow}>Your machine. No new account.</Text>
                <Text style={styles.title}>Let’s connect</Text>
                <Text style={styles.subtitle}>Use the machine you already have.</Text>
            </View>
            <View style={[styles.card, compact && styles.cardCompact]}>
                <View style={styles.cardHead}>
                    <Text style={styles.cardTitle}>Have a connect link?</Text>
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>Fastest · 20–60 sec*</Text>
                    </View>
                </View>
                <Text style={styles.inputLabel}>Private link or pairing code</Text>
                <TextInput
                    accessibilityLabel="Private link or pairing code"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="go"
                    placeholder={compact ? 'Paste' : 'Paste link'}
                    placeholderTextColor={styles.inputPlaceholder.color}
                    style={styles.input}
                    value={linkValue}
                    onChangeText={setLinkValue}
                    onSubmitEditing={connectLink}
                />
                <ActionButton title="Connect" icon={compact ? undefined : 'link-outline'} wrap onPress={connectLink} />
                {canScan ? (
                    <>
                        <ActionButton variant="secondary" title="Scan the QR" icon={compact ? undefined : 'qr-code-outline'} wrap onPress={() => { void scanPairQr(); }} />
                        <Text style={styles.hint}>Or scan its QR in the app. You’ll compare two words before access is granted.</Text>
                    </>
                ) : (
                    <Text style={styles.hint}>{browser
                        ? 'Paste the browser link from muxr on your computer. You’ll compare two words before access is granted.'
                        : `This ${pairingDeviceNoun()} can't scan a QR, so paste the pairing string muxr shows on your computer.`}</Text>
                )}
            </View>
            <View style={styles.alternatives}>
                <Text style={styles.alternativesLabel}>Not set up yet?</Text>
                <View style={styles.alternativeRow}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Cloud account. Coming soon, no action yet."
                        accessibilityState={{ disabled: true }}
                        disabled
                        style={[styles.wayTile, { flexBasis: 112 * fontScale }, styles.wayTileDisabled]}
                    >
                        <Ionicons name="cloud-outline" size={22} color={styles.wayIcon.color} />
                        <Text style={styles.wayTitle}>Cloud account</Text>
                        <Text style={styles.waySub}>Boat · 2–5 min</Text>
                        <View style={styles.soonBadge}>
                            <Text style={styles.soonText}>Soon</Text>
                        </View>
                    </Pressable>
                    {sshAvailable && (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="SSH login. Any server, 3 to 7 minutes."
                            style={({ pressed }) => [styles.wayTile, { flexBasis: 112 * fontScale }, pressed && styles.wayTilePressed]}
                            onPress={() => router.push('/pair?route=ssh')}
                        >
                            <Ionicons name="terminal-outline" size={22} color={styles.wayIcon.color} />
                            <Text style={styles.wayTitle}>SSH login</Text>
                            <Text style={styles.waySub}>Any server · 3–7 min</Text>
                        </Pressable>
                    )}
                </View>
            </View>
            <View style={styles.footer}>
                <View style={styles.trustRow}>
                    <Ionicons name="lock-closed-outline" size={14} color={styles.trust.color} />
                    <Text style={styles.trust}>Encrypted after verified pairing</Text>
                </View>
                <Text style={styles.footerSub}>Your infrastructure. No muxr-hosted relay.</Text>
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: moreWaysOpen }}
                    accessibilityLabel="More ways and timing"
                    style={styles.moreWaysToggle}
                    onPress={() => setMoreWaysOpen((open) => !open)}
                >
                    <Text style={styles.moreWaysText}>More ways &amp; timing</Text>
                </Pressable>
                {moreWaysOpen && (
                    <View style={styles.moreWaysBody}>
                        <FirstRunSetupCard variant="command" />
                        <Text style={styles.hint}>Your own HTTPS endpoint, user-owned tunnel, Tailscale or local network also work. *Estimated; a ready link excludes setup. Setup still needs your consent on the computer.</Text>
                    </View>
                )}
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: 380,
        flexGrow: 1,
        gap: 18,
    },
    intro: {
        alignSelf: 'stretch',
        gap: 8,
    },
    eyebrow: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 25,
        lineHeight: 29,
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    card: {
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 14,
        gap: 10,
    },
    cardCompact: { paddingHorizontal: 8 },
    cardHead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
    },
    cardTitle: {
        ...Typography.default('semiBold'),
        flexGrow: 1,
        flexShrink: 1,
        fontSize: 17,
        color: theme.colors.text,
    },
    badge: {
        maxWidth: '100%',
        borderRadius: 999,
        backgroundColor: theme.colors.accentSubtle,
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    badgeText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        color: theme.colors.text,
    },
    inputLabel: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    input: {
        ...Typography.default(),
        minHeight: 50,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
        color: theme.colors.text,
        paddingHorizontal: 14,
        fontSize: 16,
    },
    inputPlaceholder: {
        color: theme.colors.textSecondary,
    },
    hint: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    alternatives: {
        gap: 8,
    },
    alternativesLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    alternativeRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    wayTile: {
        flexGrow: 1,
        flexShrink: 1,
        maxWidth: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 12,
        gap: 6,
        alignItems: 'flex-start',
    },
    wayTilePressed: {
        opacity: 0.85,
    },
    wayTileDisabled: {
        opacity: 0.7,
    },
    wayIcon: {
        color: theme.colors.textSecondary,
    },
    wayTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        alignSelf: 'stretch',
        color: theme.colors.text,
    },
    waySub: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        alignSelf: 'stretch',
        color: theme.colors.textSecondary,
    },
    soonBadge: {
        borderRadius: 999,
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 2,
        marginTop: 2,
    },
    soonText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    footer: {
        marginTop: 'auto',
        paddingTop: 8,
        alignItems: 'center',
        gap: 8,
    },
    trustRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    trust: {
        ...Typography.default(),
        flexShrink: 1,
        textAlign: 'center',
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    footerSub: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    moreWaysToggle: {
        minHeight: 44,
        alignSelf: 'stretch',
        borderTopWidth: 1,
        borderColor: theme.colors.divider,
        justifyContent: 'center',
        alignItems: 'center',
    },
    moreWaysText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    moreWaysBody: {
        width: '100%',
        gap: 10,
        alignItems: 'center',
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
}));
