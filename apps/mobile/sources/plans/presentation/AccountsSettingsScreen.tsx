import * as React from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { providerName, type PlanAccount } from '../domain/planAccounts';
import { planConnection, samePlanConnection, usePlans, usePlansStore } from '../application/plansStore';
import { planFailure, removeAccount, renameAccount } from '../application/plansApi';
import { Notice, useAccountFlows, useFlows } from './AccountFlows';
import { Pill } from './accountParts';

const PROVIDERS: { id: string; title: string }[] = [
    { id: 'claude', title: 'Claude' },
    { id: 'codex', title: 'ChatGPT (Codex)' },
    { id: 'opencode', title: 'OpenCode' },
];

/**
 * Web-only: web ignores `ellipsizeMode`, so an over-long email would run off the
 * row losing the domain. The address stays on one line while the whole domain
 * fits next to a shortened local part (`umer.w…@example.com`). Only when the
 * domain alone cannot fit does it drop to a second line, broken before the `@`,
 * and each line ellipsizes its own end. The domain's own overflow (its real
 * width against the row's) picks between the two; it never wraps mid-word.
 */
function EmailSplit({ email }: { email: string }) {
    const at = email.lastIndexOf('@');
    const local = at > 0 ? email.slice(0, at) : email;
    const domain = at > 0 ? email.slice(at) : '';
    const rowRef = React.useRef<View>(null);
    const domainRef = React.useRef<Text>(null);
    const [stacked, setStacked] = React.useState(false);
    const measure = React.useCallback(() => {
        const row = rowRef.current as unknown as HTMLElement | null;
        const domainNode = domainRef.current as unknown as HTMLElement | null;
        if (row === null || domainNode === null || typeof domainNode.scrollWidth !== 'number') return;
        const next = domainNode.scrollWidth > row.clientWidth + 1;
        setStacked((previous) => (previous === next ? previous : next));
    }, []);
    React.useEffect(() => { measure(); }, [measure, local, domain]);
    return (
        <View ref={rowRef} style={stacked ? styles.emailColumn : styles.emailRow} onLayout={measure}>
            <Text style={styles.emailLocal} numberOfLines={1} ellipsizeMode="tail">{local}</Text>
            <Text ref={domainRef} style={styles.emailDomain} numberOfLines={1} ellipsizeMode="tail">{domain}</Text>
        </View>
    );
}

/** Settings → Accounts: every sign-in muxr can start an agent on, by provider. */
export function AccountsSettingsScreen() {
    const { theme } = useUnistyles();
    const list = usePlans();
    const flows = useAccountFlows();
    const connection = planConnection();
    const autoOn = usePlansStore((state) => state.autoOn);
    const setAutoOn = usePlansStore((state) => state.setAutoOn);
    const landed = useFlows((state) => state.landed);
    const notice = useFlows((state) => state.notice);
    const listRef = React.useRef<ScrollView>(null);
    // The notice is the first row of the list. After adding an account the list
    // is scrolled down to the "Add" row, so bring the notice into view; it then
    // pushes every account row below it, and the list scrolls to reach them.
    React.useEffect(() => {
        if (notice !== null) listRef.current?.scrollTo({ y: 0, animated: false });
    }, [notice]);

    const rename = async (account: PlanAccount) => {
        const name = await Modal.prompt('Rename account', account.email, {
            defaultValue: account.name,
            confirmText: 'Save',
            required: true,
            maxLength: 40,
        });
        if (!samePlanConnection(connection) || name === null || name.trim() === '' || name.trim() === account.name) return;
        await renameAccount(account.id, name.trim(), connection).catch((error) => samePlanConnection(connection) && Modal.alert("Couldn't rename", planFailure(error)));
    };

    const remove = async (account: PlanAccount) => {
        if (account.foundOnComputer) return;
        const confirmed = await Modal.confirm(
            `Remove ${account.name}?`,
            `This signs ${account.name} out on this computer. Your conversations stay.`,
            { confirmText: 'Remove', destructive: true },
        );
        if (!confirmed || !samePlanConnection(connection)) return;
        await removeAccount(account.id, connection).catch((error) => samePlanConnection(connection) && Modal.alert("Couldn't remove", planFailure(error)));
    };

    const actions = (account: PlanAccount) => Modal.alert(account.name,
        [account.email, account.foundOnComputer ? "This is the computer's own sign-in." : undefined].filter(Boolean).join('\n'), [
        { text: 'Rename', onPress: () => { if (samePlanConnection(connection)) void rename(account); } },
        { text: 'Sign in again', onPress: () => { if (samePlanConnection(connection)) flows.signIn(account); } },
        ...(account.foundOnComputer ? [] : [{ text: 'Remove', style: 'destructive' as const, onPress: () => void remove(account) }]),
        { text: 'Cancel', style: 'cancel' },
    ]);

    // Accounts of one provider must stay tellable apart at the largest text size.
    // The name wraps to two lines; the email stays on a single line so it never
    // breaks mid-word. Native keeps both ends of a too-long email (ellipsizeMode
    // "middle"); web ignores that mode, so there we split the address: the local
    // part shrinks and ellipsizes and the whole domain stays, the part that tells
    // addresses apart. Accounts that still share a name and email are told apart
    // by the usage line beneath.
    const subtitle = (account: PlanAccount): string | React.ReactNode =>
        account.signedIn && account.email
            ? (Platform.OS === 'web' ? <EmailSplit email={account.email} /> : account.email)
            : 'Signed out';
    const facts = (account: PlanAccount): string | undefined => {
        if (!account.signedIn) return undefined;
        const room = account.roomLeftPercent === undefined ? undefined : `${account.roomLeftPercent}% left`;
        return [room, account.plan, account.foundOnComputer ? 'found on this computer' : undefined]
            .filter(Boolean).join('\u00a0· ') || undefined;
    };

    return (
        <ItemList ref={listRef}>
            <Notice inline />
            <Text style={styles.lede}>
                Claude and ChatGPT show once you have more than one account for them; OpenCode shows as soon as you add one. With one Claude or ChatGPT account, muxr works exactly as before.
            </Text>
            {list === null && (
                <ItemGroup>
                    <Item title="This computer can't list accounts yet" subtitle="Update muxr on the computer to use more than one account." subtitleLines={2} />
                </ItemGroup>
            )}
            {list !== null && PROVIDERS.map((provider) => {
                const accounts = list.providers.find((entry) => entry.provider === provider.id)?.accounts ?? [];
                return (
                    <ItemGroup key={provider.id} title={provider.title}>
                        {accounts.map((account) => (
                            <Item
                                key={account.id}
                                selected={account.id === landed}
                                style={account.id === landed ? { backgroundColor: theme.colors.surfacePressed } : undefined}
                                title={account.name}
                                titleLines={2}
                                subtitle={subtitle(account)}
                                subtitleLines={1}
                                subtitleEllipsizeMode={Platform.OS === 'web' ? undefined : 'middle'}
                                meta={facts(account)}
                                metaLines={0}
                                icon={<Ionicons
                                    name={account.signedIn ? 'person-circle-outline' : 'alert-circle-outline'}
                                    size={28}
                                    color={account.signedIn ? theme.colors.text : theme.colors.textSecondary}
                                />}
                                // Signed out, the row signs in; its other actions sit behind a long press.
                                rightElement={account.signedIn ? undefined : <Pill label="Sign in" link />}
                                showChevron={account.signedIn}
                                onPress={() => (account.signedIn ? actions(account) : flows.signIn(account))}
                                onLongPress={() => actions(account)}
                                accessibilityLabel={[account.name, account.signedIn ? account.email : 'Signed out', facts(account)].filter(Boolean).join(', ')}
                            />
                        ))}
                        <Item
                            title={`Add a ${providerName(provider.id)} account`}
                            subtitle={accounts.length === 0 ? 'Next to the one already signed in on this computer' : undefined}
                            subtitleLines={2}
                            titleStyle={{ color: theme.colors.textLink }}
                            icon={<Ionicons name="add" size={26} color={theme.colors.textLink} />}
                            showChevron={false}
                            onPress={() => flows.add(provider.id)}
                        />
                    </ItemGroup>
                );
            })}
            {list !== null && (
                <ItemGroup title="When you start an agent">
                    <Item
                        title="Auto picks the most room left"
                        subtitle="Off: the account you picked last"
                        subtitleLines={2}
                        rightElement={<Switch value={autoOn} onValueChange={setAutoOn} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    lede: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        paddingHorizontal: 20,
        paddingTop: 12,
        ...Typography.default(),
    },
    emailRow: {
        flexDirection: 'row',
        maxWidth: '100%',
    },
    emailColumn: {
        flexDirection: 'column',
        maxWidth: '100%',
    },
    emailLocal: {
        flexShrink: 1,
        minWidth: 0,
        overflow: 'hidden',
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        letterSpacing: 0.1,
        color: theme.colors.textSecondary,
    },
    emailDomain: {
        flexShrink: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        letterSpacing: 0.1,
        color: theme.colors.textSecondary,
    },
}));
