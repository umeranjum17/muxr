import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useEmptyRoom } from '../application/emptyRoom';
import { openMoveSheet } from './MoveAccount';
import { styles as parts } from './accountParts';

/**
 * "Out of room" on the agent itself, with Move beside it: the account it
 * runs on emptied mid-run, and the menu row saying so is too deep to
 * notice. One line of title on the reference phone, even at large text.
 */
export function AgentEmptyBanner({ sessionId, agentKind, working }: {
    sessionId: string;
    agentKind: string | undefined;
    working: boolean;
}) {
    const { theme } = useUnistyles();
    const empty = useEmptyRoom(sessionId, agentKind);
    if (empty === null || agentKind === undefined) return null;
    const { account } = empty;
    const move = () => openMoveSheet({ sessionId, agentKind, working, currentId: account.id });
    return (
        <View style={styles.strip} accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle" size={20} color={theme.colors.box.warning.text} style={styles.icon} />
            <View style={parts.rowCopy}>
                <Text style={styles.title} numberOfLines={1}>Out of room on {account.name}</Text>
                <Text style={parts.facts} numberOfLines={1}>
                    {account.roomLabel ?? 'No room left'} · move to keep going
                </Text>
            </View>
            <Pressable onPress={move} accessibilityRole="button" accessibilityLabel={`Move to another account, now on ${account.name}`} hitSlop={8}
                style={({ pressed }) => [parts.pill, pressed && parts.pillPressed]}>
                <Text style={[parts.pillText, parts.pillLink]}>Move</Text>
            </Pressable>
        </View>
    );
}

/**
 * The same warning on the Home Live card: one tappable line under the
 * agent's name. `notePress` lets the card tell its own tap from this one,
 * so Move doesn't also open the agent underneath the sheet.
 */
export function LiveCardEmptyBadge({ sessionId, agentKind, working, notePress }: {
    sessionId: string;
    agentKind: string;
    working: boolean;
    notePress: () => void;
}) {
    const { theme } = useUnistyles();
    const empty = useEmptyRoom(sessionId, agentKind);
    if (empty === null) return null;
    const move = () => { notePress(); openMoveSheet({ sessionId, agentKind, working, currentId: empty.account.id }); };
    return (
        <Pressable onPress={move} accessibilityRole="button"
            accessibilityLabel={`Out of room on ${empty.account.name}. Move to another account.`}
            hitSlop={4} style={({ pressed }) => [styles.badge, pressed && styles.badgePressed]}>
            <Ionicons name="alert-circle" size={13} color={theme.colors.box.warning.text} />
            <Text style={styles.badgeText} numberOfLines={1}>
                Out of room · <Text style={styles.badgeLink}>Move</Text>
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    icon: {
        marginTop: 1,
    },
    strip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.box.warning.background,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.box.warning.border,
    },
    title: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingTop: 3,
    },
    badgePressed: {
        opacity: 0.6,
    },
    badgeText: {
        flex: 1,
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.box.warning.text,
        ...Typography.default('semiBold'),
    },
    badgeLink: {
        color: theme.colors.textLink,
    },
}));
