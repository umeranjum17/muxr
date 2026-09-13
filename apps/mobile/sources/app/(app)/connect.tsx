import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { getAppVersion } from '@/utils/appVersion';
import { CONNECT_AFTER_PAIR_NOTE, HERDR_SETUP_PANE_COMMAND, NPM_INSTALL_COMMAND, NPM_SETUP_COMMAND, herdrInstallCommand } from '@/demo/installCommands';
import { BrowserPairQrScanner, canScanBrowserPairQr } from '@/pairing/ui';
import type { BrowserPairingQr } from '@/pairing';
import { ActionButton } from '@/components/ActionButton';

/**
 * Connect your computer — its own screen, reached from the demo bar or setup,
 * never stacked under the demo. Setup is a thing you do once on your computer;
 * the demo is a thing you play with here, so they must not share one scroll.
 * The zero-paste QR is read on this device and hands off to your computer's
 * own address; this origin claims, stores, logs and fetches nothing.
 */
export default function ConnectScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const insets = useSafeAreaInsets();
    const version = getAppVersion();
    const [withoutHerdr, setWithoutHerdr] = React.useState(false);
    // A scanned invitation lives only here, in memory. Continue is a full
    // top-level navigation to the validated host; this origin never claims,
    // stores, logs or fetches it.
    const [scanned, setScanned] = React.useState<BrowserPairingQr | undefined>(undefined);
    return (
        <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.screen, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.card} accessibilityLiveRegion="polite">
                {scanned === undefined && (
                    <>
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
                        {canScanBrowserPairQr() && (
                            <>
                                <Text style={styles.hint}>Setup shows a QR? Scan it here. The image is read on this device and you are taken to your computer’s own address to pair — nothing is sent to or kept by this site.</Text>
                                <BrowserPairQrScanner title="Scan the QR from Setup" onScanned={setScanned} />
                            </>
                        )}
                    </>
                )}
                {scanned !== undefined && (
                    <>
                        <Text style={styles.cardTitle}>Continue to your computer</Text>
                        <Text style={styles.hint}>This QR opens the pairing page at</Text>
                        <Text selectable style={styles.command}>{scanned.origin}</Text>
                        <Text style={styles.hint}>Only continue if that is the address your computer’s setup printed. You will review the grant there before anything is paired.</Text>
                        <ActionButton title="Continue to this computer" icon="arrow-forward-outline" onPress={() => globalThis.location?.assign(scanned.url)} />
                        <ActionButton title="Scan again" variant="secondary" icon="qr-code-outline" onPress={() => setScanned(undefined)} />
                    </>
                )}
                <ActionButton title="Back to the demo" variant="quiet" icon="arrow-back-outline" onPress={() => router.back()} />
            </View>
        </ScrollView>
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
        <View style={stylesheet.commandRow}>
            <Text selectable style={stylesheet.command} accessibilityLabel={`Command: ${command}`}>{command}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : denied ? 'Copy is blocked here; select the command instead' : `Copy ${command}`} onPress={() => void copy()} style={stylesheet.copy}>
                <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={14} color={theme.colors.textSecondary} />
                {denied && !copied && <Text style={stylesheet.toggleLabel}>Select it</Text>}
            </Pressable>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    scroll: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    screen: {
        paddingHorizontal: 16,
    },
    card: {
        gap: 8,
    },
    cardTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text,
    },
    hint: {
        ...Typography.default(),
        fontSize: 13,
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
        minHeight: 44,
    },
    toggleLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
}));
