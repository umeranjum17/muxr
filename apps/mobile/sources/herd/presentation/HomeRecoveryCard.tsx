import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { ActionButton } from '@/components/ActionButton';
import { cardStyle } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { loadAppConfig } from '@/catalog';
import { isSshHostKeyChangeRefusal, isSshHostKeyPinMissing } from '@/connection';
import { useHerdrDesktopApp, useHerdrMissing, useHerdrOutdated } from '@/catalog/store';

import { useDeviceOffline } from '@/utils/web/deviceOffline';

const HOST_RESTART_COMMAND = 'muxr daemon restart';
// Doctor finds a missing Herdr and offers to install and start it.
const HERDR_INSTALL_COMMAND = 'muxr doctor';
/** An old Herdr is fixed by Herdr's own update; doctor only reports it. */
const HERDR_UPDATE_COMMAND = 'herdr update';

/**
 * Herdr's two steps, led by the one that fits the way that computer was set
 * up: the desktop app's Install Herdr on a computer it owns, the terminal
 * command on a command-line computer. The other step stays visible, second.
 */
function herdrCopy(outdated: boolean, desktopApp: boolean): { lead: string; terminal?: string; alternative?: string } {
    if (desktopApp) {
        return {
            lead: outdated
                ? 'The Herdr on that computer is out of date. Open the muxr app on it and choose Install Herdr; your agents appear here once it restarts.'
                : 'Open the muxr app on that computer and choose Install Herdr; your agents appear here once it starts.',
            terminal: 'Or run this in a terminal there:',
        };
    }
    return {
        lead: outdated ? 'muxr needs Herdr 0.9.1 or newer. Run this in a terminal there, then restart Herdr:' : 'Run this in a terminal there:',
        alternative: 'Or open the muxr app on that computer and choose Install Herdr.',
    };
}

const styles = StyleSheet.create((theme) => ({
    card: {
        width: '92%', maxWidth: 800, alignSelf: 'center', marginTop: 12,
        padding: 16, gap: 10,
    },
    title: { color: theme.colors.text, fontSize: 17, ...Typography.default('semiBold') },
    body: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20, ...Typography.default() },
    commandRow: {
        flexDirection: 'row', alignItems: 'center', borderRadius: 10,
        backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider,
        paddingLeft: 12, paddingRight: 6, paddingVertical: 6,
    },
    command: { flex: 1, color: theme.colors.text, fontSize: 14, ...Typography.mono() },
    copy: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
    actionTarget: { minHeight: 44, justifyContent: 'center' },
    action: { color: theme.colors.accent, fontSize: 14, ...Typography.default('semiBold') },
}));

export function recoveryMode(error: string | null | undefined, runtimeOffline: boolean): 'host' | 'runtime' | 'update-app' | 'update-host' | 'pair' | 'revoked' | 'ssh-key' {
    // sshTunnel.ts refuses a changed or missing host-key pin before any login; no restart or retry fixes it.
    if (isSshHostKeyChangeRefusal(error) || isSshHostKeyPinMissing(error)) return 'ssh-key';
    if (error?.startsWith('Update needed:')) return /older muxr connection protocol|Update muxr on the computer/i.test(error) ? 'update-host' : 'update-app';
    if (error?.startsWith('Pair again:')) return 'pair';
    if (error?.startsWith('Access removed:')) return 'revoked';
    return runtimeOffline ? 'runtime' : 'host';
}

export function HomeRecoveryCard({
    mode, reason, retrying, feedback, onRetry, onFeedback,
}: {
    mode: ReturnType<typeof recoveryMode>;
    reason?: string | null;
    retrying: boolean;
    feedback: string;
    onRetry: () => void;
    onFeedback: (message: string) => void;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();
    // No network on this device is not the computer's fault: say so, and skip the restart command.
    const deviceOffline = useDeviceOffline() && mode === 'host';
    const wasDeviceOffline = React.useRef(deviceOffline);
    React.useEffect(() => {
        if (wasDeviceOffline.current && !deviceOffline) onFeedback('');
        wasDeviceOffline.current = deviceOffline;
    }, [deviceOffline, onFeedback]);
    const sshKey = mode === 'ssh-key';
    const rePair = mode === 'update-app' || mode === 'update-host' || mode === 'pair' || mode === 'revoked';
    // A runtime that is down because Herdr is absent or older than muxr
    // supports: no restart brings it back, so the card leads with an install.
    const herdrMissing = useHerdrMissing() && mode === 'runtime';
    const herdrOutdated = useHerdrOutdated() && mode === 'runtime';
    const herdrBroken = herdrMissing || herdrOutdated;
    const herdrDesktopApp = useHerdrDesktopApp();
    const copy = herdrBroken ? herdrCopy(herdrOutdated, herdrDesktopApp) : undefined;
    const command = herdrOutdated ? HERDR_UPDATE_COMMAND : herdrMissing ? HERDR_INSTALL_COMMAND : HOST_RESTART_COMMAND;
    const publicBaseUrl = loadAppConfig().publicBaseUrl;
    const appDownload = Platform.OS === 'ios'
        ? 'https://testflight.apple.com/join/aJSbs8pN'
        : publicBaseUrl ? `${publicBaseUrl}/downloads/stable/android` : 'https://github.com/umeranjum17/muxr/releases/latest';
    return (
        <View style={[styles.card, cardStyle(theme)]}>
            <Text style={styles.title}>{deviceOffline ? "You're offline" : herdrOutdated ? 'Herdr is out of date on your computer' : herdrMissing ? 'Herdr is missing on your computer' : mode === 'update-app' ? 'Update the muxr app' : mode === 'update-host' ? 'Update muxr on your computer' : mode === 'pair' ? 'Pair this phone again' : mode === 'revoked' ? 'Access removed' : sshKey ? 'SSH fingerprint changed' : mode === 'host' ? 'Computer unreachable' : 'Agent runtime unavailable'}</Text>
            <Text style={styles.body}>
                {deviceOffline ? 'This device has no network. Check the connection, then tap Retry once you are back online.'
                    : copy ? copy.lead
                    : mode === 'pair' ? reason?.includes('no longer recognises')
                    ? 'Your computer no longer recognises this phone. Pair once to reconnect.'
                    : 'Your computer has a newer muxr connection. Pair once to reconnect.'
                    : mode === 'update-app' ? 'This app needs an update to connect to your computer.'
                    : mode === 'update-host' ? 'Update muxr on your computer, then pair again.'
                    : mode === 'revoked' ? 'This computer removed your access. Pair again to reconnect.'
                    : sshKey ? (reason ?? 'The SSH fingerprint changed. No login details were sent. Open Connection settings → SSH, confirm the new fingerprint, or choose Use current relay route instead.')
                    : reason ?? (mode === 'host'
                        ? 'Check that this device can reach the computer and that muxr is running.'
                        : 'The computer is reachable, but its agent runtime is not answering. Restart muxr there.')}
            </Text>
            {/* The restart command stays visible beside the Retry feedback that
                refers to it: hiding it whenever a reason exists left "run the
                command" pointing at nothing. */}
            {copy?.terminal !== undefined && <Text style={styles.body}>{copy.terminal}</Text>}
            {!rePair && !sshKey && !deviceOffline && <View style={styles.commandRow}>
                <Text selectable style={styles.command}>{command}</Text>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={herdrOutdated ? 'Copy Herdr update command' : herdrMissing ? 'Copy Herdr install command' : 'Copy host restart command'}
                    hitSlop={10}
                    style={styles.copy}
                    onPress={() => void Clipboard.setStringAsync(command)
                        .then(() => onFeedback('Command copied.'))
                        .catch(() => onFeedback('Could not copy. Select the command above.'))}
                >
                    <Ionicons name="copy-outline" size={17} color={theme.colors.textSecondary} />
                </Pressable>
            </View>}
            {copy?.alternative !== undefined && <Text style={styles.body}>{copy.alternative}</Text>}
            <View style={styles.actions}>
                {rePair ? (
                    <ActionButton
                        title={mode === 'update-app' ? 'Update app' : mode === 'update-host' ? 'Update computer' : 'Pair again'}
                        onPress={() => mode === 'update-app'
                            ? void openExternalUrl(appDownload)
                            : mode === 'update-host'
                                ? void openExternalUrl(publicBaseUrl ? `${publicBaseUrl}/docs/quickstart` : 'https://github.com/umeranjum17/muxr')
                                : router.push('/pair' as never)}
                    />
                ) : <>
                    {!sshKey && <ActionButton title={retrying ? 'Retrying…' : 'Retry connection'} accessibilityLabel="Retry connection" disabled={retrying} onPress={onRetry} />}
                    <Pressable accessibilityRole="link" onPress={() => router.push('/settings/connection' as never)} style={styles.actionTarget}>
                        <Text style={styles.action}>Connection details</Text>
                    </Pressable>
                </>}
            </View>
            {!rePair && !deviceOffline && feedback ? <Text accessibilityLiveRegion="polite" style={styles.body}>{feedback}</Text> : null}
        </View>
    );
}

/** How long a connect may run before Home says the computer is busy; a
 *  shorter connect stays silent. */
const BUSY_AFTER_MS = 5_000;

/** True once a connecting stretch that began at `since` outlasts a short
 *  connect. It flips once instead of ticking, so Home does not re-render every
 *  second while the link retries. */
export function useBusyConnecting(since: number | null): boolean {
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        if (since === null) { setBusy(false); return; }
        const wait = since + BUSY_AFTER_MS - Date.now();
        setBusy(wait <= 0);
        if (wait <= 0) return;
        const timer = setTimeout(() => setBusy(true), wait);
        return () => clearTimeout(timer);
    }, [since]);
    return busy;
}

/** Shown while the link keeps retrying a host that is slow to answer; nothing
 *  here suggests the pairing failed. Home stands in for its other connected
 *  rows while it shows, so this card is the one place that speaks. */
export function BusyConnectingCard({ since, computer }: { since: number; computer: string }) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);
    const deviceOffline = useDeviceOffline();
    const seconds = Math.max(0, Math.floor((now - since) / 1_000));
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return (
        <View style={[styles.card, cardStyle(theme)]}>
            <Text style={styles.title}>{deviceOffline ? "You're offline." : `${computer} isn't answering, likely busy.`}</Text>
            <Text accessibilityLiveRegion="polite" style={styles.body}>
                {deviceOffline
                    ? `This device has no network, so it can't reach ${computer}. Check the connection once you're back online.`
                    : `Reconnecting on its own… No answer for ${elapsed}. Your terminals come back when the computer catches up; nothing to do there.`}
            </Text>
            <View style={styles.actions}>
                <ActionButton title="Connection details" variant="secondary" onPress={() => router.push('/settings/connection' as never)} />
            </View>
        </View>
    );
}
