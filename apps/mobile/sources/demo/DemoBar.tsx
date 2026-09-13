import * as React from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { resetDemoRuntime } from './demoRuntime';

/**
 * The only demo chrome around production UI: a replay indicator, a reset
 * action, and the connect handoff. Connect is a NAVIGATION to the pair
 * screen, not an inline panel — setup (a thing you do once, on your
 * computer) and the demo (a thing you play with here) are two intents and
 * must not share one scroll: stacked, the demo composer read as if it drove
 * your machine and the install commands read as if they belonged to the demo
 * session. No prompt, no mock approve card — the blocked agent is answered in
 * its real terminal and composer.
 */
export function DemoBar({ topInset = 0 }: { topInset?: number }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    const pathname = usePathname();
    // On the connect screen itself the bar is just the demo frame; no second
    // Connect button that navigates to where you already are.
    const onConnect = pathname === '/connect';
    // Phones keep the actions to their icons; wider frames spell them out.
    const spellOut = width >= 600;
    return (
        <View style={[styles.frame, { paddingTop: topInset }]}>
        <View style={styles.bar} accessibilityRole="header" aria-level={2}>
            <Ionicons name="play-circle-outline" size={14} color={theme.colors.textSecondary} />
            <Text style={styles.label}>Demo · three scripted agents, nothing is real. Pair your computer to see yours.</Text>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Restart the demo"
                onPress={() => resetDemoRuntime()}
                style={styles.action}
            >
                <Ionicons name="refresh-outline" size={14} color={theme.colors.textSecondary} />
                {spellOut && <Text style={styles.actionLabel}>Restart</Text>}
            </Pressable>
            {!onConnect && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Connect your computer — leaves the demo and opens the connect screen"
                    onPress={() => router.push('/connect')}
                    style={styles.action}
                >
                    <Ionicons name="link-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.actionLabel}>Connect</Text>
                </Pressable>
            )}
        </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    frame: {
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 2,
    },
    label: {
        ...Typography.default(),
        flex: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        minWidth: 44,
        minHeight: 44,
        paddingHorizontal: 6,
    },
    actionLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
}));
