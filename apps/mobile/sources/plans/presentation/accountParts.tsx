import * as React from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { isEmpty, isLow, type PlanAccount } from '../domain/planAccounts';

/** "Max · 72% left this week", the figure in mono and warm once low. */
export function AccountFacts({ account, lead }: { account: PlanAccount; lead?: string }) {
    const { theme } = useUnistyles();
    const parts: React.ReactNode[] = [];
    if (lead !== undefined) parts.push(lead);
    else if (account.plan !== undefined) parts.push(account.plan);
    if (account.roomLeftPercent !== undefined) {
        const figure = `${account.roomLeftPercent}%`;
        const words = account.roomLabel?.startsWith(figure) ? account.roomLabel.slice(figure.length) : ' left';
        parts.push(
            <Text key="room" style={isLow(account) ? { color: theme.colors.box.warning.text } : null}>
                <Text style={styles.mono}>{figure}</Text>{words}
            </Text>,
        );
    }
    if (parts.length === 0) return null;
    return (
        <Text style={styles.facts} numberOfLines={2}>
            {parts.map((part, index) => (
                <React.Fragment key={index}>{index > 0 ? ' · ' : ''}{part}</React.Fragment>
            ))}
        </Text>
    );
}

export function SignInPill({ onPress, label = 'Sign in' }: { onPress: () => void; label?: string }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}
            style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}>
            <Text style={[styles.pillText, styles.pillLink]}>{label}</Text>
        </Pressable>
    );
}

/** A pill that only shows; the row around it takes the tap. */
export function Pill({ label, link }: { label: string; link?: boolean }) {
    return <View style={styles.pill}><Text style={[styles.pillText, link && styles.pillLink]}>{label}</Text></View>;
}

/** One account in a picking sheet. Signed-out accounts can't be picked. */
export function AccountRow({
    account,
    selected,
    note,
    trailing,
    onPress,
    badge,
    hideEmail,
    inert,
}: {
    account: PlanAccount;
    selected: boolean;
    /** Said after the name in place of the email ("most room left"). */
    badge?: string;
    hideEmail?: boolean;
    /** Shown, not picked (the account an agent is on now). */
    inert?: boolean;
    /** Replaces the plan at the start of the second line ("Running here now"). */
    note?: string;
    trailing?: React.ReactNode;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    // The reference phone's 270 pt: every line kept to one so the sheet fits.
    const narrow = useWindowDimensions().width < 330;
    const out = !account.signedIn;
    // An empty account stays pickable (Start warns first), but reads as spent.
    const empty = account.signedIn && isEmpty(account);
    const aside = badge ?? (hideEmail || out ? undefined : account.email);
    // A row that can't be picked is not a button: its Sign in pill is the only action.
    const still = out || inert === true;
    const content = (
        <>
            <Ionicons
                name={out ? 'alert-circle-outline' : 'person-circle-outline'}
                size={out ? 24 : 26}
                color={out ? theme.colors.textSecondary : theme.colors.text}
                style={styles.rowIcon}
            />
            <View style={styles.rowCopy}>
                <Text style={[styles.rowTitle, (out || empty) && styles.dim]} numberOfLines={1}>
                    {account.name}
                    {aside !== undefined && <Text style={styles.rowEmail}> · {aside}</Text>}
                </Text>
                {out
                    ? <Text style={styles.facts}>{note ?? (narrow ? 'Signed out' : 'Signed out — sign in again to use it')}</Text>
                    : <AccountFacts account={account} lead={note} />}
            </View>
            {trailing}
            {selected && trailing === undefined && <Ionicons name="checkmark-circle" size={20} color={theme.colors.textLink} />}
        </>
    );
    if (still) return <View style={styles.row}>{content}</View>;
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={[account.name, aside, account.plan, account.roomLabel].filter(Boolean).join(', ')}
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.row, (selected || pressed) && styles.rowSelected]}
        >
            {content}
        </Pressable>
    );
}

/** The sheet's own title: OptionSheet's leaves too much room above a lede. */
export function SheetTitle({ children }: { children: React.ReactNode }) {
    return <Text style={styles.title} accessibilityRole="header">{children}</Text>;
}

export function SheetLede({ children }: { children: React.ReactNode }) {
    return <Text style={styles.lede}>{children}</Text>;
}

export function Divider() {
    return <View style={styles.divider} />;
}

export function FootAction({ icon, label, onPress, link }: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    onPress: () => void;
    link?: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
            style={({ pressed }) => [styles.foot, pressed && styles.rowSelected]}>
            <Ionicons name={icon} size={link ? 22 : 19} color={link ? theme.colors.textLink : theme.colors.textSecondary} />
            <Text style={[styles.footText, link && styles.link]}>{label}</Text>
        </Pressable>
    );
}

/** A quiet boxed line: the terms note, the cost of a move. */
export function Note({ icon, children }: { icon: React.ComponentProps<typeof Ionicons>['name']; children: React.ReactNode }) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.note}>
            <Ionicons name={icon} size={17} color={theme.colors.textSecondary} style={styles.noteIcon} />
            <Text style={styles.noteText}>{children}</Text>
        </View>
    );
}

export function PrimaryButton({ icon, label, onPress, busy }: {
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    onPress: () => void;
    busy?: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={busy ? undefined : onPress} accessibilityRole="button" accessibilityLabel={label}
            accessibilityState={{ busy: busy === true }}
            style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}>
            {icon !== undefined && <Ionicons name={icon} size={18} color={theme.colors.fab.icon} />}
            <Text style={styles.buttonText}>{label}</Text>
        </Pressable>
    );
}

export function GhostButton({ label, onPress }: { label: string; onPress: () => void }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
            style={({ pressed }) => [styles.button, styles.ghost, pressed && styles.rowSelected]}>
            <Text style={[styles.buttonText, styles.ghostText]}>{label}</Text>
        </Pressable>
    );
}

export const Strong = ({ children }: { children: React.ReactNode }) => <Text style={styles.strong}>{children}</Text>;

export const styles = StyleSheet.create((theme) => ({
    mono: {
        ...Typography.mono(),
    },
    facts: {
        fontSize: 12,
        lineHeight: 16,
        marginTop: 1,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    title: {
        fontSize: 24,
        color: theme.colors.text,
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    lede: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        paddingHorizontal: 20,
        paddingBottom: 12,
        ...Typography.default(),
    },
    strong: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 54,
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginHorizontal: 6,
        borderRadius: 12,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowIcon: {
        width: 26,
        textAlign: 'center',
    },
    rowCopy: {
        flex: 1,
        minWidth: 0,
    },
    rowTitle: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    rowEmail: {
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    dim: {
        color: theme.colors.textSecondary,
    },
    pill: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 14,
        backgroundColor: theme.colors.surfaceHighest,
    },
    pillPressed: {
        opacity: 0.7,
    },
    pillText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    pillLink: {
        color: theme.colors.textLink,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginHorizontal: 18,
        marginVertical: 6,
    },
    foot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 40,
        paddingHorizontal: 18,
        marginHorizontal: 6,
        borderRadius: 12,
    },
    footText: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
    link: {
        color: theme.colors.textLink,
    },
    note: {
        flexDirection: 'row',
        gap: 10,
        marginHorizontal: 16,
        marginTop: 6,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    noteIcon: {
        marginTop: 1,
    },
    noteText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        height: 52,
        marginHorizontal: 16,
        marginTop: 14,
        borderRadius: 18,
        backgroundColor: theme.colors.fab.background,
    },
    buttonPressed: {
        backgroundColor: theme.colors.fab.backgroundPressed,
    },
    buttonText: {
        fontSize: 16,
        color: theme.colors.fab.icon,
        ...Typography.default('semiBold'),
    },
    ghost: {
        marginTop: 8,
        backgroundColor: 'transparent',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    ghostText: {
        color: theme.colors.text,
    },
}));
