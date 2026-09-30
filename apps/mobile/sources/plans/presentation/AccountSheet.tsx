import * as React from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { OptionSheet } from '@/components/OptionSheet';
import { hapticsLight } from '@/components/haptics';
import { AUTO, chosenAccount, providerForAgent, providerName } from '../domain/planAccounts';
import { planConnection, samePlanConnection, refreshPlans, useProviderChoice, usePlansStore } from '../application/plansStore';
import { acknowledgeAutoTerms } from '../application/plansApi';
import { useAccountFlows } from './AccountFlows';
import { AccountRow, Divider, FootAction, Note, SheetLede, SheetTitle, SignInPill, Strong, styles } from './accountParts';

/** The host's plain line with the picked account's name in bold. */
function Reason({ reason, name }: { reason: string; name: string | undefined }) {
    const at = name === undefined ? -1 : reason.indexOf(name);
    if (at < 0) return <>{reason}</>;
    return <>{reason.slice(0, at)}<Strong>{name}</Strong>{reason.slice(at + name!.length)}</>;
}

/**
 * Which account the next agent starts on. Auto first, with one plain line on
 * what it picked and why; then each account by name. Only reachable when the
 * agent's provider has two or more accounts.
 */
export function AccountSheet({ visible, agentKind, agentName, onClose, onLeave }: {
    visible: boolean;
    agentKind: string;
    agentName: string;
    onClose: () => void;
    /** Closes the screen's own modal before a flow moves elsewhere. */
    onLeave?: () => void;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    // On a short screen (the 270 × 594 reference phone) the lede would push
    // Manage accounts under the fold; the Auto row already says what it does.
    const short = useWindowDimensions().height < 640;
    const connection = planConnection();
    const { entry, choice } = useProviderChoice(agentKind);
    // Auto may pick either account from here on: the host's plain note shows
    // on the first opening only, and stays for that opening once seen.
    const unseenNote = usePlansStore((state) => (state.list?.autoTermsAcknowledged === false ? state.list.autoTermsNote : undefined));
    const [termsNote, setTermsNote] = React.useState<string>();
    React.useEffect(() => { setTermsNote(undefined); }, [connection]);
    React.useEffect(() => { if (visible) void refreshPlans(connection); }, [visible, connection]);
    const hasEntry = entry !== undefined;
    React.useEffect(() => {
        if (!visible) { setTermsNote(undefined); return; }
        if (!hasEntry || unseenNote === undefined || unseenNote === '') return;
        setTermsNote(unseenNote);
        void acknowledgeAutoTerms(connection).catch(() => {});
    }, [visible, hasEntry, unseenNote, connection]);
    const choose = usePlansStore((state) => state.choose);
    const flows = useAccountFlows(onLeave);
    const provider = providerForAgent(agentKind);
    if (entry === undefined || provider === null) return null;
    const pick = (next: string) => {
        if (!samePlanConnection(connection)) return;
        hapticsLight();
        choose(provider, next);
        onClose();
    };
    const autoSelected = choice === AUTO;
    const body = (
        <View>
            <SheetTitle>{providerName(provider)} account</SheetTitle>
            {!short && <SheetLede>{agentName} starts on the account you pick. Auto picks the one with the most room left.</SheetLede>}
            <Pressable
                onPress={() => pick(AUTO)}
                accessibilityRole="button"
                accessibilityState={{ selected: autoSelected }}
                accessibilityLabel={`Auto, most room left. ${entry.auto.reason}`}
                style={({ pressed }) => [styles.row, (autoSelected || pressed) && styles.rowSelected]}
            >
                <Ionicons name="sparkles-outline" size={22} color={theme.colors.text} style={styles.rowIcon} />
                <View style={styles.rowCopy}>
                    <Text style={styles.rowTitle} numberOfLines={1}>Auto — most room left</Text>
                    <Text style={styles.facts} numberOfLines={2}>
                        <Reason reason={entry.auto.reason} name={chosenAccount(entry, AUTO)?.name} />
                    </Text>
                </View>
                {autoSelected && <Ionicons name="checkmark-circle" size={20} color={theme.colors.textLink} />}
            </Pressable>
            {termsNote !== undefined && <Note icon="information-circle-outline">{termsNote}</Note>}
            <Divider />
            {entry.accounts.map((account) => (
                <AccountRow
                    key={account.id}
                    account={account}
                    selected={choice === account.id}
                    onPress={() => pick(account.id)}
                    trailing={account.signedIn ? undefined : <SignInPill onPress={() => { onClose(); flows.signIn(account); }} />}
                />
            ))}
            <Divider />
            <FootAction icon="add" link label={`Add a ${providerName(provider)} account`} onPress={() => { onClose(); flows.add(provider); }} />
            <FootAction icon="pencil-outline" label="Manage accounts" onPress={() => { onClose(); onLeave?.(); router.push('/settings/accounts' as never); }} />
        </View>
    );
    return <OptionSheet visible={visible} title="" options={[]} onSelect={() => {}} onClose={onClose} body={body} />;
}
