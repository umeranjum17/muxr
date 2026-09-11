import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { DEMO_INSTALL_COMMAND } from './demoRecords';
import { resetDemoRuntime } from './demoRuntime';

/**
 * The only demo chrome around production UI: a replay indicator, a reset
 * action, and the install handoff. No prompt, no mock approve card — the
 * blocked agent is answered in its real terminal and composer.
 */
export function DemoBar({ topInset = 0 }: { topInset?: number }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    // Phones keep the actions to their icons; wider frames spell them out.
    const spellOut = width >= 600;
    const [copied, setCopied] = React.useState(false);
    // Clipboard access can be refused (false) or throw; "Copied" is said
    // only on a true result, and otherwise the exact command is shown to
    // select by hand.
    const [fallback, setFallback] = React.useState(false);
    const copyInstall = React.useCallback(async () => {
        let ok = false;
        try {
            ok = await Clipboard.setStringAsync(DEMO_INSTALL_COMMAND);
        } catch {
            ok = false;
        }
        if (!ok) {
            setFallback(true);
            return;
        }
        setFallback(false);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, []);
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
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={copied ? 'Install command copied' : 'Connect your computer: copy the install command'}
                onPress={() => void copyInstall()}
                style={styles.action}
            >
                <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={14} color={theme.colors.textSecondary} />
                {(spellOut || copied) && <Text style={styles.actionLabel}>{copied ? 'Copied' : 'Connect'}</Text>}
            </Pressable>
        </View>
        {fallback && (
            <View style={styles.fallback} accessibilityLiveRegion="polite">
                <Text style={styles.fallbackHint}>Copy didn't work here. Select the command and copy it yourself:</Text>
                <Text selectable style={styles.command} accessibilityLabel={`Install command: ${DEMO_INSTALL_COMMAND}`}>{DEMO_INSTALL_COMMAND}</Text>
            </View>
        )}
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
    fallback: {
        paddingHorizontal: 16,
        paddingBottom: 10,
        gap: 4,
    },
    fallbackHint: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    command: {
        ...Typography.mono(),
        fontSize: 12,
        color: theme.colors.text,
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
