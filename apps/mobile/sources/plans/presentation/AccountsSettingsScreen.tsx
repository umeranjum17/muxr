import * as React from 'react';
import { Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { providerEntry, providerName, type PlanAccount } from '../domain/planAccounts';
import { usePlans, usePlansStore } from '../application/plansStore';
import { planFailure, removeAccount, renameAccount } from '../application/plansApi';
import { useAccountFlows } from './AccountFlows';
import { Pill } from './accountParts';

const PROVIDERS: { id: string; title: string }[] = [
    { id: 'claude', title: 'Claude' },
    { id: 'codex', title: 'ChatGPT (Codex)' },
];

/** Settings → Accounts: every sign-in muxr can start an agent on, by provider. */
export function AccountsSettingsScreen() {
    const { theme } = useUnistyles();
    const list = usePlans();
    const flows = useAccountFlows();
    const autoOn = usePlansStore((state) => state.autoOn);
    const setAutoOn = usePlansStore((state) => state.setAutoOn);

    const rename = async (account: PlanAccount) => {
        const name = await Modal.prompt('Rename account', account.email, {
            defaultValue: account.name,
            confirmText: 'Save',
            required: true,
            maxLength: 40,
        });
        if (name === null || name.trim() === '' || name.trim() === account.name) return;
        await renameAccount(account.id, name.trim()).catch((error) => Modal.alert("Couldn't rename", planFailure(error)));
    };

    const remove = async (account: PlanAccount) => {
        // A found account is only forgotten; its sign-in stays on the computer.
        const confirmed = await Modal.confirm(
            account.foundOnComputer ? `Forget ${account.name}?` : `Remove ${account.name}?`,
            account.foundOnComputer
                ? 'muxr stops offering it. Its sign-in stays on this computer, untouched.'
                : `This signs ${account.name} out on this computer. Your conversations stay.`,
            { confirmText: account.foundOnComputer ? 'Forget' : 'Remove', destructive: true },
        );
        if (!confirmed) return;
        await removeAccount(account.id).catch((error) => Modal.alert("Couldn't remove", planFailure(error)));
    };

    const actions = (account: PlanAccount) => Modal.alert(account.name, account.email, [
        { text: 'Rename', onPress: () => void rename(account) },
        { text: 'Sign in again', onPress: () => flows.signIn(account) },
        { text: account.foundOnComputer ? 'Forget' : 'Remove', style: 'destructive', onPress: () => void remove(account) },
        { text: 'Cancel', style: 'cancel' },
    ]);

    const subtitle = (account: PlanAccount): string => {
        if (!account.signedIn) return 'Signed out';
        const room = account.roomLeftPercent === undefined ? undefined : `${account.roomLeftPercent}% left`;
        return [account.email, account.plan, room, account.foundOnComputer ? 'found on this computer' : undefined]
            .filter(Boolean).join(' · ');
    };

    return (
        <ItemList>
            <Text style={styles.lede}>
                Only shown when you have more than one account for a provider. With one account, muxr works exactly as before.
            </Text>
            {list === null && (
                <ItemGroup>
                    <Item title="This computer can't list accounts yet" subtitle="Update muxr on the computer to use more than one account." subtitleLines={2} />
                </ItemGroup>
            )}
            {list !== null && PROVIDERS.map((provider) => {
                // Below two accounts the host lists none: the computer's own sign-in stays as it is.
                const accounts = providerEntry(list, provider.id)?.accounts ?? [];
                return (
                    <ItemGroup key={provider.id} title={provider.title}>
                        {accounts.map((account) => (
                            <Item
                                key={account.id}
                                title={account.name}
                                subtitle={subtitle(account)}
                                subtitleLines={2}
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
                                accessibilityLabel={`${account.name}, ${subtitle(account)}`}
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
}));
