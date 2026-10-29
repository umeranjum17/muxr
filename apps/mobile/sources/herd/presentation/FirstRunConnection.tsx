import * as React from 'react';
import { Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { sshTunnelAvailable } from '@/connection';
import { WordWrappingText } from '@/components/WordWrappingText';
import { BOAT_FROM_PER_HOUR } from '@/cloud';

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

// The first run is two equal doors: the computer the person already has, or
// a Boat cloud machine muxr sets up. Each door says what it is, how long it
// takes and what it needs or costs, then leads into its own short branch of
// steps ending on Home, where the first agent opens in a terminal. SSH stays
// a small link under the doors, never a third door.
export function FirstRunConnection() {
    const router = useRouter();
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    const browser = Platform.OS === 'web';
    // Side by side once both doors keep a readable width; stacked on a phone.
    const sideBySide = width >= 720;
    // Offer Direct SSH only when this native build includes the transport.
    const sshAvailable = !browser && sshTunnelAvailable();
    const fromPrice = `from $${BOAT_FROM_PER_HOUR} an hour`;

    return (
        <View style={[styles.section, sideBySide && styles.sectionWide]}>
            <View style={styles.intro}>
                <WordWrappingText fontSize={25} lineHeight={29} style={styles.title} accessibilityRole="header">Connect a machine</WordWrappingText>
                <Text style={styles.subtitle}>Your agents run in real terminals. Pick where; you can add the other later.</Text>
            </View>
            <View style={[styles.doors, sideBySide && styles.doorsWide]}>
                <Door
                    icon="laptop-outline"
                    title="My computer"
                    what="Pair the machine you already have."
                    lines={['About 4–5 min · about 1 min if muxr already runs', 'Needs Tailscale on both ends']}
                    wide={sideBySide}
                    onPress={() => router.push('/my-computer')}
                />
                <Door
                    icon="cloud-outline"
                    title="Cloud machine · Boat"
                    what="A Boat server runs your agents. muxr sets it up and pairs it."
                    lines={[
                        'About 4–6 min with a Boat account',
                        `Paid to Boat, ${fromPrice}`,
                        ...(browser ? ['In a browser: set up from the muxr phone app'] : []),
                    ]}
                    wide={sideBySide}
                    onPress={() => router.push('/cloud-computer')}
                />
            </View>
            {sshAvailable && (
                <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="Any server over SSH. 3 to 7 minutes."
                    style={styles.sshLink}
                    onPress={() => router.push('/pair?route=ssh')}
                >
                    <Text style={styles.sshText}>Any server over SSH · 3–7 min</Text>
                </Pressable>
            )}
            <View style={styles.trustRow}>
                <Ionicons name="lock-closed-outline" size={14} color={styles.trust.color} />
                <Text style={styles.trust}>Encrypted after verified pairing. No new muxr account.</Text>
            </View>
        </View>
    );
}

function Door(props: {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    what: string;
    lines: string[];
    wide: boolean;
    onPress: () => void;
}) {
    const styles = stylesheet;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={[props.title, props.what, ...props.lines].join('. ')}
            style={({ pressed }) => [styles.door, props.wide && styles.doorWide, pressed && styles.doorPressed]}
            onPress={props.onPress}
        >
            <View style={styles.doorHead}>
                <View style={styles.doorIcon}><Ionicons name={props.icon} size={20} color={styles.doorTitle.color} /></View>
                <Text style={styles.doorTitle}>{props.title}</Text>
                <Ionicons name="chevron-forward" size={20} color={styles.doorMeta.color} />
            </View>
            <Text style={styles.doorWhat}>{props.what}</Text>
            {props.lines.map((line, index) => (
                <Text key={line} style={[styles.doorMeta, index === 0 && styles.doorTime]}>{line}</Text>
            ))}
        </Pressable>
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
    sectionWide: { maxWidth: 820 },
    intro: {
        alignSelf: 'stretch',
        gap: 8,
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
    doors: { gap: 10 },
    doorsWide: { flexDirection: 'row', gap: 16 },
    door: {
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 14,
        gap: 6,
    },
    doorWide: { flex: 1, flexBasis: 0, padding: 20, minHeight: 200 },
    doorPressed: { opacity: 0.85 },
    doorHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    doorIcon: {
        width: 32,
        height: 32,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    doorTitle: {
        ...Typography.default('semiBold'),
        flex: 1,
        minWidth: 0,
        fontSize: 18,
        lineHeight: 23,
        color: theme.colors.text,
    },
    doorWhat: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    doorMeta: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    doorTime: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    sshLink: {
        alignSelf: 'center',
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 8,
    },
    sshText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        textAlign: 'center',
        textDecorationLine: 'underline',
        color: theme.colors.text,
    },
    trustRow: {
        marginTop: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    trust: {
        ...Typography.default(),
        flexShrink: 1,
        textAlign: 'center',
        fontSize: 12,
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
}));
