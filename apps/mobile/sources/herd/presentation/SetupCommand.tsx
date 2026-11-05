import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Platform, Pressable, Share, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { WordWrappingText } from '@/components/WordWrappingText';

// What the installer does, read from install.sh and the first-run path in
// scripts/setup/presentation/setupWizard.mjs: a first run asks one question
// (the route, already chosen) and keeps every other default.
const SETUP_EFFECTS = [
    'Installs muxr for your user, with no sudo. Needs Node.js 22 or newer.',
    'Asks one question: how your phone reaches the computer. Enter takes the recommended answer.',
    'Installs Herdr, the terminal engine, if the computer has none, then ends on a QR to scan.',
] as const;

/**
 * The one line that gets a computer from nothing to a pairing QR: monospace
 * block, Copy, and (on a phone) Share to send it to the computer, then the
 * plain-words list of what running it does. Used by every first-run step that
 * tells a person what to paste on the computer.
 */
export function SetupCommand(props: { command: string; shareable?: boolean; effectsOpen?: boolean }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [notice, setNotice] = React.useState<string | undefined>();
    const [effectsOpen, setEffectsOpen] = React.useState(props.effectsOpen === true);
    const copy = React.useCallback(() => {
        void Clipboard.setStringAsync(props.command).then((ok) => {
            setNotice(ok === false ? 'Could not copy. Type the command shown above on your computer.' : 'Copied. Paste it in a terminal on your computer.');
        }, () => setNotice('Could not copy. Type the command shown above on your computer.'));
    }, [props.command]);
    const share = React.useCallback(() => {
        setNotice(undefined);
        void Share.share({ message: props.command }).catch(() => {
            setNotice('Could not open sharing. Copy the command instead.');
        });
    }, [props.command]);
    return (
        <View style={styles.root}>
            <View style={styles.block}>
                <Text style={styles.command} selectable>{props.command}</Text>
            </View>
            <View style={styles.actions}>
                <Pressable accessibilityRole="button" accessibilityLabel="Copy command" hitSlop={6} style={[styles.action, styles.actionPrimary]} onPress={copy}>
                    <Ionicons name="copy-outline" size={18} color={theme.colors.button.primary.tint} />
                    <Text style={[styles.actionText, styles.actionPrimaryText]}>Copy</Text>
                </Pressable>
                {props.shareable && Platform.OS !== 'web' && (
                    <Pressable accessibilityRole="button" accessibilityLabel="Share command" hitSlop={6} style={styles.action} onPress={share}>
                        <Ionicons name="share-outline" size={18} color={theme.colors.text} />
                        <Text style={styles.actionText}>Share</Text>
                    </Pressable>
                )}
            </View>
            {notice !== undefined && <Text accessibilityLiveRegion="polite" style={styles.hint}>{notice}</Text>}
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: effectsOpen }}
                accessibilityLabel="What running this does"
                hitSlop={8}
                style={styles.effectsToggle}
                onPress={() => setEffectsOpen((open) => !open)}
            >
                <Ionicons name={effectsOpen ? 'chevron-down-outline' : 'chevron-forward-outline'} size={13} color={theme.colors.textSecondary} />
                {/* Its own column: a row would size the label to its scaled text. */}
                <View style={styles.effectsToggleLabel}>
                    <WordWrappingText fontSize={13} style={styles.effectsToggleText}>What running this does</WordWrappingText>
                </View>
            </Pressable>
            {effectsOpen && (
                <View style={styles.effectsBody}>
                    {SETUP_EFFECTS.map((line) => (
                        <View key={line} style={styles.effectRow}>
                            <Text style={styles.effectDash}>{'–'}</Text>
                            <Text style={styles.hint}>{line}</Text>
                        </View>
                    ))}
                </View>
            )}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    root: { alignSelf: 'stretch', gap: 8 },
    block: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    command: { ...Typography.mono(), fontSize: 13, lineHeight: 19, color: theme.colors.text },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    actionPrimary: { backgroundColor: theme.colors.button.primary.background, borderColor: theme.colors.button.primary.background },
    actionPrimaryText: { color: theme.colors.button.primary.tint },
    actionText: { ...Typography.default('semiBold'), fontSize: 14, color: theme.colors.text },
    hint: { ...Typography.default(), flexShrink: 1, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    effectsToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 32 },
    effectsToggleLabel: { flex: 1 },
    effectsToggleText: { ...Typography.default('semiBold'), flexShrink: 1, fontSize: 13, color: theme.colors.textSecondary },
    effectsBody: { gap: 10, paddingTop: 2 },
    effectRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    effectDash: { ...Typography.default('semiBold'), fontSize: 13, lineHeight: 18, width: 10, color: theme.colors.textSecondary },
}));
