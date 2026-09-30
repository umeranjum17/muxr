import * as React from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { create } from 'zustand';
import { OptionSheet } from '@/components/OptionSheet';
import { navigateToSession } from '@/herd';
import { Modal } from '@/modal';
import { bestMoveTarget, isLow, runningOn, type PlanAccount } from '../domain/planAccounts';
import { planConnection, samePlanConnection, refreshPlans, usePlans, usePlansStore, useProviderChoice, type PlanConnection } from '../application/plansStore';
import { agentAccount, moveAgent, planFailure } from '../application/plansApi';
import { showNotice, useAccountFlows } from './AccountFlows';
import { AccountRow, Note, Pill, PrimaryButton, SheetLede, SheetTitle, SignInPill, styles as parts } from './accountParts';

/** The agents an account can carry, by the names the dock gives them. */
const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };

interface Moving { connection: PlanConnection; sessionId: string; agentKind: string; working: boolean; currentId?: string }

const useMoving = create<{ moving: Moving | null }>()(() => ({ moving: null }));

usePlansStore.subscribe((state, previous) => {
    if (state.connection !== previous.connection) useMoving.setState({ moving: null });
});

/**
 * One row in a running agent's menu, and only when its provider has another
 * account to move to: "Move to another account · On Personal · 18% left".
 */
export function MoveAccountRow({ sessionId, agentKind, working, onOpen }: {
    sessionId: string;
    agentKind: string | undefined;
    working: boolean;
    onOpen: () => void;
}) {
    const { theme } = useUnistyles();
    usePlans();
    const connection = planConnection();
    const { entry } = useProviderChoice(agentKind ?? '');
    const [recorded, setRecorded] = React.useState<{ connection: PlanConnection; sessionId: string; id?: string } | null>(null);
    const known = entry !== undefined;
    React.useEffect(() => {
        if (!known) return;
        let live = true;
        setRecorded(null);
        void agentAccount(sessionId, connection).then((id) => { if (live && samePlanConnection(connection)) setRecorded({ connection, sessionId, id }); }).catch((error) => {
            if (live && samePlanConnection(connection)) Modal.alert("Couldn't find the current account", planFailure(error));
        });
        return () => { live = false; };
    }, [known, sessionId, connection]);
    if (agentKind === undefined || entry === undefined) return null;
    const current = recorded?.connection === connection && recorded.sessionId === sessionId ? runningOn(entry, recorded.id) : undefined;
    return (
        <Pressable
            disabled={current === undefined}
            accessibilityState={{ disabled: current === undefined }}
            onPress={() => { if (current === undefined) return; onOpen(); useMoving.setState({ moving: { connection, sessionId, agentKind, working, currentId: current?.id } }); }}
            accessibilityRole="button"
            accessibilityLabel={`Move to another account${current ? `, on ${current.name}` : ''}${current?.roomLeftPercent !== undefined ? `, ${current.roomLeftPercent}% left` : ''}`}
            style={({ pressed }) => [styles.menuRow, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh }]}
        >
            <Ionicons name="swap-horizontal-outline" size={18} color={theme.colors.textSecondary} />
            <View style={parts.rowCopy}>
                <Text style={styles.menuText}>Move to another account</Text>
                {current !== undefined && (
                    <Text style={styles.menuSub} numberOfLines={1}>
                        On {current.name}
                        {current.roomLeftPercent !== undefined && (
                            <Text style={isLow(current) ? { color: theme.colors.box.warning.text } : null}> · <Text style={parts.mono}>{current.roomLeftPercent}%</Text> left</Text>
                        )}
                    </Text>
                )}
            </View>
            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
        </Pressable>
    );
}

/** The move itself: the roomiest other account preselected, the current one
 *  marked Now, and the cost said plainly. Mounted once in the overlay. */
export function MoveSheet() {
    const router = useRouter();
    const moving = useMoving((state) => state.moving);
    const { entry } = useProviderChoice(moving?.agentKind ?? '');
    const flows = useAccountFlows();
    const accounts: PlanAccount[] = entry?.accounts ?? [];
    const current = moving === null || entry === undefined ? undefined : runningOn(entry, moving.currentId);
    const best = bestMoveTarget(accounts, current?.id);
    // Said only when true of every account, the one it runs on included.
    const roomiest = best?.roomLeftPercent !== undefined
        && accounts.every((account) => !account.signedIn || (account.roomLeftPercent ?? -1) <= best.roomLeftPercent!);
    const [picked, setPicked] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    // The short reference phone keeps the accounts, the cost and the button on screen.
    const short = useWindowDimensions().height < 640;

    React.useEffect(() => {
        setPicked(null);
        setBusy(false);
        if (moving === null) return;
        void refreshPlans();
    }, [moving]);

    const close = () => useMoving.setState({ moving: null });
    if (moving === null || entry === undefined) {
        return <OptionSheet visible={false} title="" options={[]} onSelect={() => {}} onClose={close} body={<View />} />;
    }
    const target = accounts.find((account) => account.id === (picked ?? best?.id) && account.signedIn && account.id !== current?.id);
    const agentName = AGENT_NAMES[moving.agentKind] ?? moving.agentKind;

    const move = async () => {
        if (target === undefined || busy) return;
        if (moving.working) {
            const go = await Modal.confirm(
                `${agentName} is still working`,
                'Moving stops the current step. The conversation carries on from there.',
                { cancelText: 'Wait', confirmText: `Move to ${target.name}` },
            );
            if (!go || !samePlanConnection(moving.connection)) return;
        }
        setBusy(true);
        try {
            const result = await moveAgent(moving.sessionId, target.id, moving.connection);
            if (!samePlanConnection(moving.connection)) return;
            close();
            if (result.sessionId !== moving.sessionId) navigateToSession(router, result.sessionId);
            showNotice(`Moved to ${target.name}`, `Same conversation${current ? ` · ${current.name} is free again` : ''}`, true);
        } catch (error) {
            if (!samePlanConnection(moving.connection)) return;
            const recovery = (error as { sessionId?: unknown }).sessionId;
            if (typeof recovery === 'string' && recovery !== moving.sessionId) {
                let currentId: string | undefined;
                try {
                    currentId = await agentAccount(recovery, moving.connection);
                } catch {
                    if (!samePlanConnection(moving.connection)) return;
                    close();
                    navigateToSession(router, recovery);
                    Modal.alert("Couldn't move", planFailure(error));
                    return;
                }
                if (!samePlanConnection(moving.connection)) return;
                useMoving.setState({ moving: { ...moving, sessionId: recovery, currentId } });
                navigateToSession(router, recovery);
            }
            setBusy(false);
            const said = planFailure(error);
            // A failed start may have left the conversation elsewhere; the host's sentence says where.
            const startFailed = (error as { code?: unknown }).code === 'plan-move-start-failed' || said.startsWith("Couldn't start on");
            Modal.alert(`Couldn't move to ${target.name}`, `${said}${current && !startFailed ? ` The conversation is still on ${current.name}.` : ''}`);
        }
    };

    return (
        <OptionSheet
            visible
            title=""
            options={[]}
            onSelect={() => {}}
            onClose={close}
            body={
                <View>
                    <SheetTitle>Move to another account</SheetTitle>
                    {!short && <SheetLede>This conversation carries on where it stopped, on the account you pick. {agentName} restarts in this tab.</SheetLede>}
                    {accounts.map((account) => (account.id === current?.id
                        ? <AccountRow key={account.id} account={account} selected={false} note="Running here now" onPress={() => {}} trailing={<Pill label="Now" />} hideEmail inert />
                        : <AccountRow
                            key={account.id}
                            account={account}
                            hideEmail
                            selected={account.id === target?.id}
                            onPress={() => setPicked(account.id)}
                            trailing={account.signedIn ? undefined : <SignInPill onPress={() => { close(); flows.signIn(account); }} />}
                            badge={account.id === best?.id && roomiest ? 'most room left' : undefined}
                        />
                    ))}
                    {target !== undefined && (
                        <Note icon="time-outline">
                            {target.name} reads this conversation once from the start. After that it costs the same as usual.
                        </Note>
                    )}
                    <PrimaryButton
                        icon="swap-horizontal-outline"
                        label={target === undefined ? 'Pick an account' : busy ? `Moving to ${target.name}…` : `Move to ${target.name}`}
                        busy={busy || target === undefined}
                        onPress={() => void move()}
                    />
                </View>
            }
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    menuRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    menuText: {
        color: theme.colors.text,
        fontSize: 15,
    },
    menuSub: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 2,
    },
}));
