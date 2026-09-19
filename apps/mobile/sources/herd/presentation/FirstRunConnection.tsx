import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useHostedPairing, usePairQrScanner } from '@/pairing';
import { sshTunnelAvailable } from '@/connection';
import { ActionButton } from '@/components/ActionButton';
import { FirstRunSetupCard } from './FirstRunSetupCard';

/**
 * The first-connection route chooser. The previous first run led every user
 * into one QR path and hid the SSH fields behind completed pairing, so an
 * SSH-fluent person had to pair blind before reaching the fields they wanted.
 * Now the two routes sit side by side before anything is scanned: the
 * recommended QR route (with its time cost, the exact host command and a
 * three-step What-happens inside FirstRunSetupCard) and a manual route that
 * opens the existing SSH fields immediately. Every other supported route —
 * pasting a pairing string for a computer you are not standing at — stays
 * findable under the secondary Other ways choice.
 */
type Route = 'chooser' | 'recommended';

function RouteCard(props: {
    title: string;
    badge?: string;
    subtitle: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
}) {
    const styles = stylesheet;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${props.title}${props.badge === undefined ? '' : `. ${props.badge}`}`}
            style={(pressed) => [styles.routeCard, pressed && styles.routeCardPressed]}
            onPress={props.onPress}
        >
            <View style={styles.routeIcon}>
                <Ionicons name={props.icon} size={22} color={styles.routeTitle.color} />
            </View>
            <View style={styles.routeBody}>
                <View style={styles.routeTitleRow}>
                    <Text style={styles.routeTitle}>{props.title}</Text>
                    {props.badge !== undefined && (
                        <View style={styles.routeBadge}>
                            <Text style={styles.routeBadgeText}>{props.badge}</Text>
                        </View>
                    )}
                </View>
                <Text style={styles.routeSubtitle}>{props.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={16} color={styles.routeSubtitle.color} />
        </Pressable>
    );
}

export function FirstRunConnection() {
    const router = useRouter();
    const styles = stylesheet;
    const [route, setRoute] = React.useState<Route>('chooser');
    const [otherWaysOpen, setOtherWaysOpen] = React.useState(false);
    const browser = Platform.OS === 'web';
    const processPairLink = useHostedPairing();
    const scanPairQr = usePairQrScanner((url) => void processPairLink(url), true);
    // Direct SSH is an Android transport in this codebase; the card is hidden
    // where the native module is absent rather than offered as a dead choice.
    const sshAvailable = !browser && sshTunnelAvailable();

    const promptForPairingString = React.useCallback(async () => {
        const pasted = await Modal.prompt(
            'Enter pairing string',
            'Paste the short link shown by `muxr pair --browser` for eight hours of control, `muxr pair --browser-personal` for 30 days of control on a browser only you use, or `muxr pair --browser-view` for view-only access.',
            { placeholder: browser ? 'https://your-relay/pair?pair=…' : 'wss://your-relay?pair=7KDM4-QXP7N' },
        );
        if (!pasted?.trim()) return;
        await processPairLink(pasted.trim());
    }, [browser, processPairLink]);

    if (route === 'recommended') {
        return (
            <View style={styles.section}>
                <FirstRunSetupCard />
                <View style={styles.actions}>
                    {browser ? (
                        <>
                            <ActionButton title="Enter pairing string" icon="keypad-outline" action={promptForPairingString} />
                            <Text style={styles.routeHint}>Browsers pair by string: paste the link shown by `muxr pair --browser` on that computer.</Text>
                        </>
                    ) : (
                        <>
                            <ActionButton title="Scan QR to pair" icon="qr-code-outline" action={scanPairQr} />
                            <Text style={styles.routeHint}>Recommended · ~1 min · for the computer in front of you.</Text>
                        </>
                    )}
                    <ActionButton variant="quiet" title="Back to connection choices" icon="chevron-back-outline" onPress={() => setRoute('chooser')} />
                </View>
            </View>
        );
    }

    return (
        <View style={styles.section}>
            <RouteCard
                icon="qr-code-outline"
                title={browser ? 'Pair from your computer' : 'Pair with a QR code'}
                badge="Recommended · ~1 min"
                subtitle={browser
                    ? 'Run one command on your computer, then paste the pairing link here.'
                    : 'Run one command on your computer, then scan the code it shows.'}
                onPress={() => setRoute('recommended')}
            />
            {sshAvailable && (
                <RouteCard
                    icon="terminal-outline"
                    title="Connect over SSH"
                    subtitle="Already comfortable with SSH? Enter the host, user, and key yourself."
                    onPress={() => router.push('/pair?route=ssh')}
                />
            )}
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: otherWaysOpen }}
                accessibilityLabel="Other ways to connect"
                hitSlop={8}
                style={styles.otherWaysToggle}
                onPress={() => setOtherWaysOpen((open) => !open)}
            >
                <Ionicons name={otherWaysOpen ? 'chevron-down-outline' : 'chevron-forward-outline'} size={13} color={styles.routeHint.color} />
                <Text style={styles.otherWaysText}>Other ways to connect</Text>
            </Pressable>
            {otherWaysOpen && (
                <View style={styles.otherWaysBody}>
                    <ActionButton
                        variant="secondary"
                        title="Enter pairing string"
                        icon="keypad-outline"
                        action={browser ? promptForPairingString : async () => router.push('/pair')}
                    />
                    <Text style={styles.routeHint}>For a computer you are not standing at — copy the string from `muxr pair` in its terminal.</Text>
                </View>
            )}
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
    actions: {
        alignSelf: 'center',
        width: '100%',
        gap: 10,
    },
    routeCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        padding: 16,
    },
    routeCardPressed: {
        opacity: 0.85,
    },
    routeIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accentSubtle,
    },
    routeBody: {
        flex: 1,
        gap: 3,
    },
    routeTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
    },
    routeTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
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
    routeSubtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    otherWaysToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        gap: 5,
        minHeight: 36,
        paddingHorizontal: 8,
    },
    otherWaysText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textSecondary,
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
