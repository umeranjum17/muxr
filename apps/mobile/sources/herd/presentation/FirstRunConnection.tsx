import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Platform, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { pairingDeviceNoun, usePairQrScannerAvailable, useHostedPairing, usePairQrScanner } from '@/pairing';
import { sshTunnelAvailable } from '@/connection';
import { ActionButton } from '@/components/ActionButton';
import { WordWrappingText } from '@/components/WordWrappingText';
import { useCompactWindow } from '@/components/useCompactWindow';
import { FirstRunSetupCard, SetupStep } from './FirstRunSetupCard';
import { addComputerLink } from '@/commercialization';
import { openTailscaleStore } from './tailscaleApp';
import { JustThisPhoneCard } from '@/phone/ui';

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

// The first run reads as three steps: Tailscale on both ends, muxr on the
// computer (the Linux desktop app where this build can hand over its link),
// then pairing. Paste and Scan share the existing validator and consent route;
// this shell does not claim an offer or store a grant.
export function FirstRunConnection() {
    const router = useRouter();
    const styles = stylesheet;
    const { fontScale } = useWindowDimensions();
    const compact = useCompactWindow();
    const [linkValue, setLinkValue] = React.useState('');
    const [moreWaysOpen, setMoreWaysOpen] = React.useState(false);
    const browser = Platform.OS === 'web';
    const processPairLink = useHostedPairing();
    const canScan = usePairQrScannerAvailable();
    const scanPairQr = usePairQrScanner(processPairLink, canScan);
    // Offer Direct SSH only when this native build includes the transport.
    const sshAvailable = !browser && sshTunnelAvailable();
    const canAddComputer = addComputerLink() !== undefined;
    const device = browser ? 'device' : pairingDeviceNoun();
    // A compact step drops its number badge, so the title carries the number.
    const stepTitle = (number: number, title: string) => compact ? `${number}. ${title}` : title;
    const connectLink = React.useCallback(() => {
        void processPairLink(linkValue.trim());
    }, [processPairLink, linkValue]);
    // An empty field makes the button Paste a link: the computer's link from
    // `muxr link`, copied on this device, pairs from one tap.
    const pasteLink = React.useCallback(() => {
        void Clipboard.getStringAsync().then((text) => {
            setLinkValue(text);
            void processPairLink(text.trim());
        }, () => undefined);
    }, [processPairLink]);
    const empty = linkValue.trim() === '';

    return (
        <View style={styles.section}>
            <View style={styles.intro}>
                <Text style={styles.eyebrow}>Your machine. No new account.</Text>
                <WordWrappingText fontSize={25} lineHeight={29} style={styles.title}>Let’s connect</WordWrappingText>
                <Text style={styles.subtitle}>Use the machine you already have.</Text>
            </View>
            <JustThisPhoneCard />
            <View style={[styles.card, compact && styles.cardCompact]}>
                <SetupStep
                    number={1}
                    compact={compact}
                    title={stepTitle(1, 'Get Tailscale')}
                    hint={`Install the free Tailscale app on this ${device} and on your computer. Sign in to the same account on both.`}
                >
                    <View style={styles.stepAction}>
                        <ActionButton variant="secondary" title="Get Tailscale" icon={compact ? undefined : 'download-outline'} wrap action={openTailscaleStore} />
                    </View>
                </SetupStep>
                <SetupStep
                    number={2}
                    compact={compact}
                    title={stepTitle(2, 'Get muxr on your computer')}
                    hint={canAddComputer
                        ? 'Download the Linux desktop app there and open it. It shows a QR to pair.'
                        : 'Install muxr there and run it. More ways below has the command.'}
                >
                    {canAddComputer && (
                        <View style={styles.stepAction}>
                            <ActionButton
                                title="Get the desktop app"
                                icon={compact ? undefined : 'laptop-outline'}
                                wrap
                                accessibilityLabel="Get the desktop app. Open its download link on your computer."
                                onPress={() => router.push('/add-computer')}
                            />
                        </View>
                    )}
                </SetupStep>
            </View>
            <View style={[styles.card, compact && styles.cardCompact]}>
                <SetupStep number={3} compact={compact} title={stepTitle(3, 'Pair with your computer')} />
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
                <ActionButton title={empty && !browser ? 'Paste a link' : 'Connect'} icon={compact ? undefined : 'link-outline'} wrap onPress={empty && !browser ? pasteLink : connectLink} />
                {canScan ? (
                    <>
                        <ActionButton variant="secondary" title="Scan the QR" icon={compact ? undefined : 'qr-code-outline'} wrap onPress={() => { void scanPairQr(); }} />
                        <Text style={styles.hint}>On your computer, run muxr link. Copy the link it shows, or scan its QR.</Text>
                    </>
                ) : (
                    <Text style={styles.hint}>{browser
                        ? 'Paste the browser link from muxr on your computer. You’ll compare two words before access is granted.'
                        : `This ${pairingDeviceNoun()} can't scan a QR, so paste the pairing string muxr shows on your computer.`}</Text>
                )}
            </View>
            <View style={styles.alternatives}>
                <Text style={styles.alternativesLabel}>Other ways</Text>
                <View style={styles.alternativeRow}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={browser ? 'Cloud computer. Set up from the muxr phone app.' : 'Add a cloud computer. Boat.'}
                        style={({ pressed }) => [styles.wayTile, { flexBasis: 112 * fontScale }, pressed && styles.wayTilePressed]}
                        onPress={() => router.push('/cloud-computer')}
                    >
                        <Ionicons name="cloud-outline" size={22} color={styles.wayIcon.color} />
                        <Text style={styles.wayTitle}>Cloud computer</Text>
                        <Text style={styles.waySub}>{browser ? 'Set up from the muxr phone app' : 'Boat · 2–5 min'}</Text>
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
                        <Text style={styles.hint}>Your own HTTPS endpoint, user-owned tunnel, Tailscale or local network also work. Setup still needs your consent on the computer.</Text>
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
    stepAction: { marginTop: 6 },
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
