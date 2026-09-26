import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useHostedPairing, usePairQrScanner } from '@/pairing';
import { sshTunnelAvailable } from '@/connection';
import { ActionButton } from '@/components/ActionButton';
import { FirstRunSetupCard } from './FirstRunSetupCard';

/**
 * The first-connection route chooser, guided. The previous first run led every
 * user into one QR path and hid the SSH fields behind completed pairing, so an
 * SSH-fluent person had to pair blind before reaching the fields they wanted.
 * Now the two routes sit side by side before anything is scanned, each tile
 * previewing the shape of its path; the recommended route walks Run → Scan →
 * Review one step at a time with the QR in its own bounded state, and every
 * other supported route — pasting a pairing string for a computer you are not
 * standing at — stays findable under the secondary Other ways choice.
 */
type Route = 'chooser' | 'run' | 'scan';

const RUN_PREVIEW = '1 Run one command  →  2 Scan the QR  →  3 Done';
const SSH_PREVIEW = '1 Host  →  2 User  →  3 Key — no QR.';

/** Three dots + labels; the current step is the loud one. */
export function ProgressRail(props: { step: 'run' | 'scan' }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const steps = [
        { key: 'run', label: 'Run' },
        { key: 'scan', label: 'Scan' },
        { key: 'review', label: 'Review' },
    ] as const;
    return (
        <View style={styles.rail} accessibilityRole="header" accessibilityLabel={`Fast pairing, step ${props.step === 'run' ? 1 : 2} of 3`}>
            {steps.map((step, index) => {
                const reached = step.key === props.step || (props.step === 'scan' && step.key === 'run');
                const current = step.key === props.step;
                return (
                    <React.Fragment key={step.key}>
                        {index > 0 && <View style={styles.railLine} />}
                        <View style={styles.railStep}>
                            <View style={[styles.railDot, { backgroundColor: current ? theme.colors.text : theme.colors.accentSubtle }]} />
                            <Text style={[styles.railLabel, current && styles.railLabelCurrent]}>{step.label}</Text>
                        </View>
                    </React.Fragment>
                );
            })}
        </View>
    );
}

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
            style={(pressed) => [styles.routeTile, pressed && styles.routeTilePressed]}
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
    const [route, setRoute] = React.useState<Route>('chooser');
    const [otherWaysOpen, setOtherWaysOpen] = React.useState(false);
    const browser = Platform.OS === 'web';
    const processPairLink = useHostedPairing();
    const scanPairQr = usePairQrScanner((url) => void processPairLink(url), true);
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

    if (route === 'run' || route === 'scan') {
        if (browser) {
            // Browsers have no camera QR path: the run step pairs by string.
            return (
                <View style={styles.section}>
                    <FirstRunSetupCard variant="command" />
                    <View style={styles.actions}>
                        <ActionButton title="Enter pairing string" icon="keypad-outline" action={promptForPairingString} />
                        <Text style={styles.routeHint}>Browsers pair by string: paste the link shown by `muxr pair --browser` on that computer.</Text>
                        <ActionButton variant="quiet" title="← Different route" onPress={() => setRoute('chooser')} />
                    </View>
                </View>
            );
        }
        if (route === 'run') {
            return (
                <View style={styles.section}>
                    <ProgressRail step="run" />
                    <Text style={styles.kicker}>Step 1 · On your computer</Text>
                    <FirstRunSetupCard variant="command" />
                    <View style={styles.actions}>
                        <ActionButton title="I ran it — scan the QR" icon="qr-code-outline" onPress={() => setRoute('scan')} />
                        <Text style={styles.routeHint}>Recommended · ~1 min · for the computer in front of you.</Text>
                        <ActionButton variant="quiet" title="← Different route" onPress={() => setRoute('chooser')} />
                    </View>
                </View>
            );
        }
        return (
            <View style={styles.section}>
                <ProgressRail step="scan" />
                <View style={styles.viewfinder}>
                    <View style={[styles.viewfinderCorner, styles.cornerTopLeft]} />
                    <View style={[styles.viewfinderCorner, styles.cornerTopRight]} />
                    <View style={[styles.viewfinderCorner, styles.cornerBottomLeft]} />
                    <View style={[styles.viewfinderCorner, styles.cornerBottomRight]} />
                    <Text style={styles.viewfinderCaption}>Point this phone at the QR shown on your computer.</Text>
                </View>
                <View style={styles.actions}>
                    <ActionButton title="Open the scanner" icon="qr-code-outline" action={scanPairQr} />
                    <ActionButton variant="secondary" title="Paste a pairing string instead" icon="keypad-outline" action={promptForPairingString} />
                    <ActionButton variant="quiet" title="← Different route" onPress={() => setRoute('run')} />
                </View>
            </View>
        );
    }

    return (
        <View style={styles.section}>
            <RouteTile
                title="Pair with a QR code"
                badge="Recommended · ~1 min"
                preview={RUN_PREVIEW}
                onPress={() => setRoute('run')}
            />
            {sshAvailable && (
                <RouteTile
                    title="Connect over SSH"
                    preview={SSH_PREVIEW}
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
                        action={browser ? promptForPairingString : async () => { router.push('/pair'); }}
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
    kicker: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    rail: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingVertical: 4,
    },
    railStep: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    railDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
    },
    railLine: {
        width: 28,
        height: 1,
        backgroundColor: theme.colors.divider,
    },
    railLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    railLabelCurrent: {
        color: theme.colors.text,
    },
    viewfinder: {
        width: 232,
        height: 232,
        borderRadius: 20,
        borderWidth: 1.5,
        borderColor: theme.colors.divider,
        alignSelf: 'center',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    viewfinderCorner: {
        position: 'absolute',
        width: 26,
        height: 26,
        borderColor: theme.colors.text,
    },
    cornerTopLeft: {
        top: 10,
        left: 10,
        borderTopWidth: 2.5,
        borderLeftWidth: 2.5,
        borderTopLeftRadius: 8,
    },
    cornerTopRight: {
        top: 10,
        right: 10,
        borderTopWidth: 2.5,
        borderRightWidth: 2.5,
        borderTopRightRadius: 8,
    },
    cornerBottomLeft: {
        bottom: 10,
        left: 10,
        borderBottomWidth: 2.5,
        borderLeftWidth: 2.5,
        borderBottomLeftRadius: 8,
    },
    cornerBottomRight: {
        bottom: 10,
        right: 10,
        borderBottomWidth: 2.5,
        borderRightWidth: 2.5,
        borderBottomRightRadius: 8,
    },
    viewfinderCaption: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        textAlign: 'center',
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
