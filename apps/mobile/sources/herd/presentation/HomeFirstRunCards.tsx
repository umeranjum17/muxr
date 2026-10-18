import * as React from 'react';
import { AppState, Linking, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { ActionButton } from '@/components/ActionButton';
import { cardStyle } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { useAuth } from '@/account/ui';
import { resolveAgentCatalog } from '@/catalog';
import { sync } from '@/catalog/sync';
import { getCachedConnectionSettings } from '@/connection';
import { agentName, firstAgentOffer, startNewAgent, type FirstAgentOffer } from '@/spawn';
import { useAllMachines, useHerdrTree, useLocalSettingMutable, useSessions, useSocketStatus } from '@/catalog/store';
import { openBackgroundActivitySettings } from '@/../modules/voice-overlay';
import { notificationPermissionStatus, requestNotificationPermission } from '@/utils/microphonePermissions';
import { getWebInstallState, promptWebInstall, subscribeWebInstall, type WebInstallState } from '@/utils/webInstall';
import { openWebInstallGuide } from '@/settings';
import { t } from '@/text';
import { herdNotificationState, sortHerd } from '../domain/herd';

const styles = StyleSheet.create((theme) => ({
    card: {
        width: '92%', maxWidth: 800, alignSelf: 'center', marginTop: 12,
        padding: 16, gap: 10,
    },
    // On the first-run screen the card sits in the centered section below
    // FirstRunConnection, so it takes that container width instead of Home's
    // wide 92% card, and drops the Home-only top margin so it flows with the
    // section gap.
    cardFirstRun: {
        width: '100%', maxWidth: 360, marginTop: 0,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    title: { flex: 1, color: theme.colors.text, fontSize: 17, ...Typography.default('semiBold') },
    body: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20, ...Typography.default() },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
    // A row of its own: in the wrapping row web sizes the pill to its label
    // and lets it run past the card instead of fitting the card's width.
    fullRow: { width: '100%' },
    dismissTarget: { minHeight: 44, justifyContent: 'center' },
    dismiss: { color: theme.colors.textSecondary, fontSize: 14, ...Typography.default('semiBold') },
}));

/**
 * One-time Home card for a user with no agents yet. When an agent on the
 * computer is ready it starts it in one tap; otherwise it says, in one plain
 * sentence, what to do for the best candidate, with the picker one tap away.
 * It goes away for good after the first agent starts (no agents means the
 * card's condition) or after dismiss (the persisted flag).
 */
export function FirstAgentCard() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [dismissed, setDismissed] = useLocalSettingMutable('firstAgentCardDismissed');
    const [offer, setOffer] = React.useState<FirstAgentOffer | undefined>();
    const [error, setError] = React.useState<string | undefined>();
    const [startFailed, setStartFailed] = React.useState(false);
    const machines = useAllMachines({ includeOffline: true });
    const check = React.useCallback(async (refresh: boolean) => {
        try {
            const { options, authoritative } = resolveAgentCatalog(await sync.request('herdr.agentKinds', { refresh }));
            setOffer(authoritative ? firstAgentOffer(options) : undefined);
            setError(undefined);
        } catch {
            setError('Could not reach your computer. Try again.');
        }
    }, []);
    React.useEffect(() => { void check(false); }, [check]);
    if (dismissed) return null;
    // Opening the picker keeps the card: it retires once an agent starts or on Not now.
    const choose = () => router.push('/new-agent' as never);
    const start = async (kind: string) => {
        setError(undefined);
        const settings = getCachedConnectionSettings();
        const machine = machines.find((candidate) => candidate.id === settings.machineId);
        const result = await startNewAgent({
            directory: settings.lastSessionCwd || machine?.metadata?.defaultStartFolder || '~',
            kinds: [kind],
            squad: false,
            worktree: false,
        });
        if (result.error === undefined) return;
        setStartFailed(true);
        await check(true);
        setError(result.error);
    };
    const name = offer !== undefined && offer.step !== 'install' ? agentName(offer.kind) : '';
    let body = 'Pick an agent on your computer and put it to work. It appears here, live, the moment it starts.';
    if (offer?.step === 'start') body = `${name} is ready on your computer.`;
    if (offer?.step === 'sign-in') body = `Sign in to ${name} on your computer, then tap Check again.`;
    if (offer?.step === 'choose') body = `Choose ${name} to start it, and sign in on your computer if it asks.`;
    if (offer?.step === 'install') body = 'Install a coding agent such as Claude Code on your computer, then tap Check again.';
    const oneTap = offer?.step === 'start' && !startFailed;
    const checkable = offer?.step === 'sign-in' || offer?.step === 'install' || startFailed || error !== undefined;
    let pickerTitle = offer === undefined ? 'Start an agent' : 'Choose an agent';
    // Beside Start <agent>, one word: at 270 dp and the largest text a longer
    // label breaks onto two lines.
    if (offer?.step === 'start') pickerTitle = 'Agents';
    if (startFailed) pickerTitle = 'Open agents';
    return (
        <View style={[styles.card, cardStyle(theme)]}>
            <View style={styles.row}>
                <Ionicons name="rocket-outline" size={22} color={theme.colors.accent} />
                <Text style={styles.title}>Start your first agent</Text>
            </View>
            <Text style={styles.body}>{body}</Text>
            {error !== undefined && <Text style={[styles.body, { color: theme.colors.deleteAction }]}>{error}</Text>}
            <View style={styles.actions}>
                {oneTap ? (
                    <ActionButton title={`Start ${name}`} icon="play-circle-outline" wrap action={() => start(offer.kind)} />
                ) : checkable ? (
                    <ActionButton title="Check again" icon="refresh-outline" action={() => check(true)} />
                ) : null}
                <View style={styles.fullRow}>
                    <ActionButton
                        title={pickerTitle}
                        icon="add-circle-outline"
                        variant={offer?.step === 'start' || checkable ? 'secondary' : 'primary'}
                        wrap
                        onPress={choose}
                    />
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Dismiss first agent card" onPress={() => setDismissed(true)} style={styles.dismissTarget}>
                    <Text style={styles.dismiss}>Not now</Text>
                </Pressable>
            </View>
        </View>
    );
}

/**
 * In-app primer before the OS notification prompt. The system prompt only
 * ever follows the person's own turn-on tap, never fires on its own, and
 * never appears while Home is still connecting. "Not now" answers for
 * good; Settings > Notifications stays the way back. A permanent denial
 * points at system settings instead of a dead turn-on button.
 */
export function HomeNotificationPrimerCard() {
    const { theme } = useUnistyles();
    const { status } = useSocketStatus();
    const { isAuthenticated } = useAuth();
    const [answered, setAnswered] = useLocalSettingMutable('notificationPrimerAnswered');
    const [permission, setPermission] = React.useState<{ granted: boolean; canAskAgain: boolean } | null>(null);
    const primerPlatform = Platform.OS === 'ios' || (Platform.OS === 'android' && Platform.Version >= 33);
    React.useEffect(() => {
        if (!primerPlatform || !isAuthenticated || answered) return;
        let live = true;
        const read = () => {
            void notificationPermissionStatus().then((next) => { if (live) setPermission(next); });
        };
        read();
        const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') read(); });
        return () => { live = false; subscription.remove(); };
    }, [answered, isAuthenticated, primerPlatform]);
    if (!primerPlatform || !isAuthenticated || status !== 'connected' || answered || permission === null || permission.granted) return null;
    const denied = !permission.canAskAgain;
    const turnOn = async () => {
        await requestNotificationPermission();
        const next = await notificationPermissionStatus();
        if (next.granted) setAnswered(true);
        setPermission(next);
    };
    return (
        <View style={[styles.card, cardStyle(theme)]}>
            <View style={styles.row}>
                <Ionicons name="notifications-outline" size={22} color={theme.colors.accent} />
                <Text style={styles.title}>Know when an agent needs you</Text>
            </View>
            <Text style={styles.body}>
                {denied
                    ? 'Notifications are turned off for muxr. Turn them on in system settings to hear when an agent asks you something or runs into trouble.'
                    : 'muxr can tell you when an agent asks you a question or runs into a problem, even when you are not looking at the app.'}
            </Text>
            <View style={styles.actions}>
                {denied ? (
                    <ActionButton title="Open settings" icon="settings-outline" onPress={() => Linking.openSettings()} />
                ) : (
                    <ActionButton title="Turn on" icon="notifications-outline" action={turnOn} />
                )}
                <Pressable accessibilityRole="button" accessibilityLabel="Dismiss notification primer card" onPress={() => setAnswered(true)} style={styles.dismissTarget}>
                    <Text style={styles.dismiss}>Not now</Text>
                </Pressable>
            </View>
        </View>
    );
}

/**
 * The battery prompt as a non-blocking Home card instead of a blocking modal.
 * Same trigger condition the modal used (Android, signed in, herd working,
 * not yet explained) and the same action and copy intent.
 */
export function HomeBatteryCard() {
    const { theme } = useUnistyles();
    const sessions = useSessions();
    const { workspaces } = useHerdrTree();
    const { status } = useSocketStatus();
    const { isAuthenticated } = useAuth();
    const [prompted, setPrompted] = useLocalSettingMutable('backgroundConnectionPrompted');
    const panes = React.useMemo(() => sortHerd(sessions, workspaces), [sessions, workspaces]);
    const herd = React.useMemo(() => herdNotificationState(panes, status), [panes, status]);
    const herdActive = herd.mode === 'working' || herd.mode === 'attention';
    if (Platform.OS !== 'android' || !isAuthenticated || !herdActive || prompted) return null;
    const openSettings = () => {
        setPrompted(true);
        openBackgroundActivitySettings();
    };
    return (
        <View style={[styles.card, cardStyle(theme)]}>
            <View style={styles.row}>
                <Ionicons name="battery-charging-outline" size={22} color={theme.colors.accent} />
                <Text style={styles.title}>Keep muxr connected in the background?</Text>
            </View>
            <Text style={styles.body}>
                Android may pause muxr when you leave the app. Open app settings, choose Battery, then allow background activity or select Unrestricted. If your phone manages apps automatically, turn that off and allow background running.
            </Text>
            <View style={styles.actions}>
                <ActionButton title="Open settings" icon="settings-outline" onPress={openSettings} />
                <Pressable accessibilityRole="button" accessibilityLabel="Dismiss background connection card" onPress={() => setPrompted(true)} style={styles.dismissTarget}>
                    <Text style={styles.dismiss}>Not now</Text>
                </Pressable>
            </View>
        </View>
    );
}

function useWebInstallInviteState(): WebInstallState {
    return React.useSyncExternalStore(subscribeWebInstall, getWebInstallState, getWebInstallState);
}

/**
 * One-time Home invitation to install muxr from a browser tab, sitting right
 * below the Right now strip. It reuses the flow PR 765 added: on Chromium it
 * hands back the held install prompt, and on iOS it opens the Add to Home
 * Screen guide. It never renders on native, once installed, in a browser with
 * no install path, or after the person dismisses it on this device (the
 * persisted flag), so nobody is invited to install something already there.
 */
export function HomeWebInstallInvite({ variant = 'home' }: { variant?: 'home' | 'firstRun' } = {}) {
    const { theme } = useUnistyles();
    const state = useWebInstallInviteState();
    const [dismissed, setDismissed] = useLocalSettingMutable('webInstallInviteDismissed');
    // Only an actionable install path earns the invitation: a held prompt or
    // the iOS guide. A dismissed prompt (browser-menu) or no path shows nothing.
    if (dismissed || (state !== 'ready' && state !== 'ios-guide')) return null;
    const ios = state === 'ios-guide';
    return (
        <View style={[styles.card, variant === 'firstRun' && styles.cardFirstRun, cardStyle(theme)]}>
            <View style={styles.row}>
                <Ionicons name="download-outline" size={22} color={theme.colors.accent} />
                <Text style={styles.title}>{t('webInstall.inviteTitle')}</Text>
            </View>
            <Text style={styles.body}>{t('webInstall.inviteBody')}</Text>
            <View style={styles.actions}>
                <ActionButton
                    title={ios ? t('webInstall.inviteIosAction') : t('webInstall.rowTitle')}
                    icon={ios ? 'share-outline' : 'download-outline'}
                    wrap
                    onPress={ios ? openWebInstallGuide : () => void promptWebInstall()}
                />
                <Pressable accessibilityRole="button" accessibilityLabel={t('webInstall.inviteDismiss')} onPress={() => setDismissed(true)} style={styles.dismissTarget}>
                    <Text style={styles.dismiss}>{t('webInstall.inviteDismiss')}</Text>
                </Pressable>
            </View>
        </View>
    );
}
