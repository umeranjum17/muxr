import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
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
                <ActionButton title="Start your first agent" icon="add-circle-outline" onPress={start} />
                <Pressable accessibilityRole="button" accessibilityLabel="Dismiss first agent card" onPress={() => setDismissed(true)} style={styles.dismissTarget}>
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
