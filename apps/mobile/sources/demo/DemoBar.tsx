import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { getAppVersion } from '@/utils/appVersion';
import { CONNECT_AFTER_PAIR_NOTE, HERDR_SETUP_PANE_COMMAND, NPM_INSTALL_COMMAND, NPM_SETUP_COMMAND, herdrInstallCommand } from './installCommands';
import { resetDemoRuntime } from './demoRuntime';

/**
 * The only demo chrome around production UI: a replay indicator, a reset
 * action, and the connect handoff. No prompt, no mock approve card — the
 * blocked agent is answered in its real terminal and composer.
 */
export function DemoBar({ topInset = 0 }: { topInset?: number }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    // Phones keep the actions to their icons; wider frames spell them out.
    const spellOut = width >= 600;
    const [open, setOpen] = React.useState(false);
    const [withoutHerdr, setWithoutHerdr] = React.useState(false);
    const version = getAppVersion();
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
                accessibilityLabel={open ? 'Hide the connect steps' : 'Connect your computer: show the install steps'}
                accessibilityState={{ expanded: open }}
                onPress={() => setOpen((value) => !value)}
                style={styles.action}
            >
                <Ionicons name={open ? 'chevron-up-outline' : 'link-outline'} size={14} color={theme.colors.textSecondary} />
                {(spellOut || open) && <Text style={styles.actionLabel}>{open ? 'Hide' : 'Connect'}</Text>}
            </Pressable>
        </View>
        {open && (
            <View style={styles.card} accessibilityLiveRegion="polite">
                <Text style={styles.cardTitle}>Connect your computer</Text>
                <Text style={styles.hint}>In Herdr, on the computer that runs your agents:</Text>
                <CommandLine command={herdrInstallCommand(version)} />
                <CommandLine command={HERDR_SETUP_PANE_COMMAND} />
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: withoutHerdr }} onPress={() => setWithoutHerdr((value) => !value)} style={styles.toggle}>
                    <Ionicons name={withoutHerdr ? 'chevron-down-outline' : 'chevron-forward-outline'} size={12} color={theme.colors.textSecondary} />
                    <Text style={styles.toggleLabel}>Without Herdr</Text>
                </Pressable>
                {withoutHerdr && (
                    <>
                        <Text style={styles.hint}>Node 22 or newer, then:</Text>
                        <CommandLine command={NPM_INSTALL_COMMAND} />
                        <CommandLine command={NPM_SETUP_COMMAND} />
                    </>
                )}
                <Text style={styles.hint}>{CONNECT_AFTER_PAIR_NOTE}</Text>
            </View>
        )}
        </View>
    );
}

function CommandLine({ command }: { command: string }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [copied, setCopied] = React.useState(false);
    const [denied, setDenied] = React.useState(false);
    // Clipboard access can be refused (false) or throw; "Copied" is said only
    // on a true result. The command is always visible and selectable, so a
    // refused copy leaves the reader with the exact text either way.
    const copy = React.useCallback(async () => {
        let ok = false;
        try {
            ok = await Clipboard.setStringAsync(command);
        } catch {
            ok = false;
        }
        setDenied(!ok);
        setCopied(ok);
        if (ok) setTimeout(() => setCopied(false), 2000);
    }, [command]);
    return (
        <View style={styles.commandRow}>
            <Text selectable style={styles.command} accessibilityLabel={`Command: ${command}`}>{command}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : denied ? 'Copy is blocked here; select the command instead' : `Copy ${command}`} onPress={() => void copy()} style={styles.copy}>
                <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={14} color={theme.colors.textSecondary} />
                {denied && !copied && <Text style={styles.toggleLabel}>Select it</Text>}
            </Pressable>
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
    card: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        gap: 6,
    },
    cardTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
    },
    hint: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    commandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    command: {
        ...Typography.mono(),
        flex: 1,
        fontSize: 12,
        color: theme.colors.text,
    },
    copy: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 44,
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 6,
    },
    toggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minHeight: 32,
    },
    toggleLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
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
