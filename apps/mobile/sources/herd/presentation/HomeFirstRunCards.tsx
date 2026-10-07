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
import { useHerdrTree, useLocalSettingMutable, useSessions, useSocketStatus } from '@/catalog/store';
import { openBackgroundActivitySettings } from '@/../modules/voice-overlay';
import { notificationPermissionStatus, requestNotificationPermission } from '@/utils/microphonePermissions';
import { herdNotificationState, sortHerd } from '../domain/herd';

const styles = StyleSheet.create((theme) => ({
    card: {
        width: '92%', maxWidth: 800, alignSelf: 'center', marginTop: 12,
        padding: 16, gap: 10,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    title: { flex: 1, color: theme.colors.text, fontSize: 17, ...Typography.default('semiBold') },
    body: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20, ...Typography.default() },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
    dismissTarget: { minHeight: 44, justifyContent: 'center' },
    dismiss: { color: theme.colors.textSecondary, fontSize: 14, ...Typography.default('semiBold') },
}));

/**
 * One-time Home card for a user with no agents yet: it opens the start-agent
 * flow and goes away for good after the first agent starts (no agents means
 * the card's condition) or after dismiss (the persisted flag).
 */
export function FirstAgentCard() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [dismissed, setDismissed] = useLocalSettingMutable('firstAgentCardDismissed');
    if (dismissed) return null;
    const start = () => {
        setDismissed(true);
        router.push('/new-agent' as never);
    };
    return (
        <View style={[styles.card, cardStyle(theme)]}>
            <View style={styles.row}>
                <Ionicons name="rocket-outline" size={22} color={theme.colors.accent} />
                <Text style={styles.title}>Start your first agent</Text>
            </View>
            <Text style={styles.body}>
                Pick an agent on your computer and put it to work. It appears here, live, the moment it starts.
            </Text>
            <View style={styles.actions}>
                <ActionButton title="Start an agent" icon="add-circle-outline" onPress={start} />
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
                    : 'Muxr can tell you when an agent asks you a question or runs into a problem, even when you are not looking at the app.'}
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
