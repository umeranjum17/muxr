import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Pressable, Text, View } from 'react-native';
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
export function DemoBar() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [copied, setCopied] = React.useState(false);
    const copyInstall = React.useCallback(async () => {
        await Clipboard.setStringAsync(DEMO_INSTALL_COMMAND);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, []);
    return (
        <View style={styles.bar}>
            <Ionicons name="play-circle-outline" size={14} color={theme.colors.textSecondary} />
            <Text style={styles.label}>Demo replay — deterministic, no backend</Text>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Restart demo replay"
                onPress={() => resetDemoRuntime()}
                style={styles.action}
            >
                <Ionicons name="refresh-outline" size={14} color={theme.colors.textSecondary} />
            </Pressable>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={copied ? 'Install command copied' : 'Copy install command'}
                onPress={() => void copyInstall()}
                style={styles.action}
            >
                <Ionicons name="copy-outline" size={14} color={theme.colors.textSecondary} />
                {copied && <Text style={styles.copied}>Copied</Text>}
            </Pressable>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
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
        gap: 4,
        padding: 6,
    },
    copied: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
}));
