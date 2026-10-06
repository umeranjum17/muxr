import * as React from 'react';
import { Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import Animated, { FadeInDown, FadeInUp, FadeOutDown, FadeOutUp, ReduceMotion } from 'react-native-reanimated';
import { MMKV } from 'react-native-mmkv';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { create } from 'zustand';
import { OptionSheet } from '@/components/OptionSheet';
import { Typography } from '@/constants/Typography';
import { useHerdrTree } from '@/catalog/store';
import { navigateToSession } from '@/herd';
import { Modal } from '@/modal';
import { AUTO, nameSuggestions, providerEntry, providerForAgent, providerName, runningOn, type PlanAccount } from '../domain/planAccounts';
import { planConnection, samePlanConnection, refreshPlans, usePlansStore, type PlanConnection } from '../application/plansStore';
import { agentAccount, cancelSignIn, planFailure, renameAccount, signInState, startSignIn } from '../application/plansApi';
import { GhostButton, Note, Pill, PrimaryButton, SheetLede, SheetTitle, Strong, styles as parts } from './accountParts';

const TOOL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const AGENTS: Record<string, string> = { claude: 'Claude Code or Pi on a Claude model', codex: 'Codex' };

interface Pending { accountId: string; sessionId: string; provider: string; again: boolean; name?: string; cancelled?: boolean; failure?: string }

interface FlowState {
    adding: string | null;
    pending: Pending | null;
    naming: { account: PlanAccount; again: boolean } | null;
    /** The account a sign-in just finished on: Accounts marks its row for a moment. */
    landed: string | null;
    /** It stays up until it is tapped or another notice replaces it: a timer
     *  owned a message the person still had to read, and one shorter than the
     *  trip to Appearance meant it could never be seen in the other theme. */
    notice: { title: string; detail: string } | null;
}

export const useFlows = create<FlowState>()(() => ({ adding: null, pending: null, naming: null, landed: null, notice: null }));

let opening: { cancelled: boolean } | null = null;

usePlansStore.subscribe((state, previous) => {
    if (state.connection === previous.connection) return;
    opening = null;
    useFlows.setState({ adding: null, pending: null, naming: null, landed: null, notice: null });
});

const seen = new MMKV();
const termsKey = (provider: string) => `plans-terms-seen:${provider}`;

export function showNotice(title: string, detail: string): void {
    useFlows.setState({ notice: { title, detail } });
}

/** After Start, says which account the agent started on, as the host
 *  recorded it rather than as picked: Auto and a stale list can differ. */
export async function announceStartAccount(sessionId: string, agentKind: string, choice: string, connection: PlanConnection): Promise<void> {
    const entry = providerEntry(usePlansStore.getState().list, providerForAgent(agentKind));
    if (entry === undefined) return;
    let account: PlanAccount | undefined;
    try {
        account = runningOn(entry, await agentAccount(sessionId, connection));
    } catch (error) {
        if (samePlanConnection(connection)) showNotice('Agent started', `Couldn't check which account it is on: ${planFailure(error)}`);
        return;
    }
    if (account === undefined || !samePlanConnection(connection)) return;
    showNotice(`Started on ${account.name}${choice === AUTO ? ' (Auto)' : ''}`, account.roomLabel ?? `${providerName(entry.provider)} account`);
}

/** Add an account, or sign an existing one in again. `leave` closes whatever
 *  modal the flow starts from before the app moves to the sign-in tab. */
export function useAccountFlows(leave?: () => void) {
    const router = useRouter();
    const connection = planConnection();
    return React.useMemo(() => {
        const open = async (provider: string, account?: PlanAccount) => {
            if (!samePlanConnection(connection)) return;
            if (opening !== null || useFlows.getState().pending !== null) {
                Modal.alert('Sign-in is already open', 'Finish or cancel that sign-in before opening another.');
                return;
            }
            const attempt = { cancelled: false };
            opening = attempt;
            try {
                const started = await startSignIn(provider, account?.id, connection);
                if (!samePlanConnection(connection)) return;
                const pending = { ...started, provider, again: account !== undefined, ...(account === undefined ? {} : { name: account.name }) };
                if (attempt.cancelled) {
                    useFlows.setState({ pending: { ...pending, cancelled: true } });
                    await cancelSignIn(started.accountId, connection);
                    if (!samePlanConnection(connection)) return;
                    if (useFlows.getState().pending?.accountId === started.accountId) useFlows.setState({ pending: null });
                    return;
                }
                useFlows.setState({ adding: null, pending });
                leave?.();
                // Over the screen the flow started on: the tab steps back to it when it ends.
                navigateToSession(router, started.sessionId, { comeBack: true });
            } catch (error) {
                if (!samePlanConnection(connection)) return;
                if (!attempt.cancelled) useFlows.setState({ adding: null });
                Modal.alert(`Couldn't open ${providerName(provider)} sign-in`, planFailure(error));
            } finally {
                if (opening === attempt) opening = null;
            }
        };
        return {
            add: (provider: string) => { if (!samePlanConnection(connection)) return; if (opening !== null) opening.cancelled = true; leave?.(); useFlows.setState({ adding: provider }); },
            signIn: (account: PlanAccount) => { void open(account.provider, account); },
            open,
        };
    }, [leave, router, connection]);
}

/** Step one: what is about to happen, in three lines, and the terms note once. */
export function AddAccountSheet() {
    const provider = useFlows((state) => state.adding);
    const connection = planConnection();
    const flows = useAccountFlows();
    const [busy, setBusy] = React.useState(false);
    // A short screen keeps the three steps' titles and loses their detail, so
    // the button stays on screen.
    const short = useWindowDimensions().height < 640;
    const close = () => { if (opening !== null) opening.cancelled = true; useFlows.setState({ adding: null }); };
    React.useEffect(() => { if (provider === null) setBusy(false); }, [provider, connection]);
    if (provider === null) return <OptionSheet visible={false} title="" options={[]} onSelect={() => {}} onClose={close} body={<View />} />;
    const name = providerName(provider);
    // Once per provider, the plain terms note; after that only the reassurance.
    const firstTerms = seen.getBoolean(termsKey(provider)) !== true;
    const step = (n: number, title: string, detail: string) => (
        <View style={styles.step} key={n}>
            <View style={styles.num}><Text style={styles.numText}>{n}</Text></View>
            <View style={parts.rowCopy}>
                <Text style={styles.stepTitle}>{title}</Text>
                {!short && <Text style={parts.facts}>{detail}</Text>}
            </View>
        </View>
    );
    return (
        <OptionSheet
            visible
            title=""
            options={[]}
            onSelect={() => {}}
            onClose={close}
            body={
                <View>
                    <SheetTitle>Add a {name} account</SheetTitle>
                    {!short && <SheetLede>Use a second {name} plan from this computer, e.g. your work plan next to your personal one.</SheetLede>}
                    {step(1, `${name}'s own sign-in opens in a new tab`, `The real ${TOOL[provider]}, on a private folder just for this account.`)}
                    {step(2, 'Sign in with the account you want to add', `Your password and keys stay with ${name}. muxr never sees them.`)}
                    {step(3, "Give it a name you'll recognise", "We suggest one from the account's email.")}
                    <Note icon="shield-checkmark-outline">
                        Your other accounts are not touched.{firstTerms ? " Each plan's own terms still apply: some providers don't allow a second account used only to get more usage." : ''}
                    </Note>
                    <PrimaryButton
                        icon="log-in-outline"
                        label={busy ? 'Opening…' : `Open ${name} sign-in`}
                        busy={busy}
                        onPress={() => {
                            if (firstTerms) seen.set(termsKey(provider), true);
                            setBusy(true);
                            void flows.open(provider).finally(() => { if (samePlanConnection(connection)) setBusy(false); });
                        }}
                    />
                    {busy && <Text style={styles.opening}>Setting up this account's private folder, then opening {name}'s sign-in. This can take a few seconds.</Text>}
                    <GhostButton label="Cancel" onPress={close} />
                </View>
            }
        />
    );
}

const POLL_MS = 2_000;

/** Step two, on the sign-in tab itself: says whose sign-in it is, waits for
 *  the tool to report signed in, then moves on by itself. A sign-in that ends
 *  without signing in says why and offers to try again. */
export function SignInBanner({ bottom }: { bottom: number }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pending = useFlows((state) => state.pending);
    const connection = planConnection();
    const flows = useAccountFlows();
    const [cancelling, setCancelling] = React.useState(false);
    React.useEffect(() => { setCancelling(false); }, [connection]);
    const path = usePathname();
    // The tab's route changes once Herdr sees the provider's tool running in
    // it, so the tab is found by its pane, not by the route it opened on.
    const { workspaces } = useHerdrTree();
    const onTab = (route: string): boolean => {
        const current = useFlows.getState().pending;
        const decoded = decodeURIComponent(route);
        if (current === null || !decoded.startsWith('/session/')) return false;
        const id = decoded.slice('/session/'.length);
        if (id === current.sessionId) return true;
        const pane = workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes)).find((candidate) => candidate.sessionId === id);
        return pane !== undefined && current.sessionId === `shell:${pane.paneId}`;
    };
    const onTabRef = React.useRef(onTab);
    onTabRef.current = onTab;
    const pathRef = React.useRef(path);
    pathRef.current = path;
    const here = pending !== null && onTab(path);
    // The host closes the tab before it answers, so the tree can drop its pane
    // first: ask whether the phone is on the tab before the request, then step
    // back only if it is still on that same route.
    const tabRoute = React.useCallback((): string | undefined => (onTabRef.current(pathRef.current) ? pathRef.current : undefined), []);
    const leaveTab = React.useCallback((route: string | undefined) => { if (route !== undefined && pathRef.current === route && router.canGoBack()) router.back(); }, [router]);

    React.useEffect(() => {
        if (pending === null || pending.cancelled || pending.failure !== undefined) return;
        let stopped = false;
        const tick = async () => {
            if (!samePlanConnection(connection) || useFlows.getState().pending !== pending) return;
            const route = tabRoute();
            const state = await signInState(pending.accountId, connection).catch(() => null);
            if (!samePlanConnection(connection) || stopped || useFlows.getState().pending !== pending) return;
            if (state?.account.signedIn) {
                // The host has closed the tab: step back off it, then name the account.
                leaveTab(route);
                useFlows.setState({ pending: null, naming: { account: state.account, again: pending.again }, landed: state.account.id });
                void refreshPlans();
                return;
            }
            if (state?.failure !== undefined) {
                useFlows.setState({ pending: { ...pending, failure: state.failure } });
                return;
            }
            timer = setTimeout(tick, POLL_MS);
        };
        let timer = setTimeout(tick, POLL_MS);
        return () => { stopped = true; clearTimeout(timer); };
    }, [pending, leaveTab, tabRoute, connection]);

    if (pending === null || (!here && !pending.cancelled && pending.failure === undefined)) return null;
    const cancel = async (): Promise<boolean> => {
        if (cancelling || useFlows.getState().pending !== pending || !samePlanConnection(connection)) return false;
        setCancelling(true);
        const cancelled = { ...pending, cancelled: true };
        useFlows.setState({ pending: cancelled });
        const route = tabRoute();
        try {
            await cancelSignIn(pending.accountId, connection);
            if (!samePlanConnection(connection)) return false;
            if (useFlows.getState().pending === cancelled) useFlows.setState({ pending: null });
            leaveTab(route);
            return true;
        } catch (error) {
            if (!samePlanConnection(connection)) return false;
            Modal.alert("Couldn't cancel sign-in", planFailure(error));
            return false;
        } finally {
            setCancelling(false);
        }
    };
    const retry = async () => {
        const account = pending.again
            ? providerEntry(usePlansStore.getState().list, pending.provider)?.accounts.find((candidate) => candidate.id === pending.accountId)
            : undefined;
        if (await cancel()) await flows.open(pending.provider, account);
    };
    const failed = pending.failure !== undefined && !pending.cancelled;
    const title = pending.cancelled
        ? 'Cancelling sign-in…'
        : failed ? "Sign-in didn't finish" : `Signing in ${pending.name ?? `your ${providerName(pending.provider)} account`}…`;
    const detail = failed ? pending.failure : 'Finish signing in below, then come back here. This tab closes by itself once you are signed in.';
    return (
        <Animated.View
            entering={FadeInDown.duration(180).reduceMotion(ReduceMotion.System)}
            exiting={FadeOutDown.duration(140).reduceMotion(ReduceMotion.System)}
            style={[styles.banner, { bottom }]}
            accessibilityLiveRegion="polite"
        >
            <Ionicons name={failed ? 'alert-circle' : 'time-outline'} size={20} color={failed ? theme.colors.box.warning.text : theme.colors.textSecondary} />
            <View style={parts.rowCopy}>
                <Text style={styles.bannerTitle}>{title}</Text>
                <Text style={parts.facts}>{detail}</Text>
            </View>
            {failed && (
                <Pressable disabled={cancelling} onPress={() => void retry()} accessibilityRole="button" accessibilityLabel="Try signing in again" hitSlop={8}
                    style={({ pressed }) => [parts.pill, pressed && parts.pillPressed]}>
                    <Text style={[parts.pillText, parts.pillLink]}>Try again</Text>
                </Pressable>
            )}
            <Pressable disabled={cancelling} onPress={() => void cancel()} accessibilityRole="button" accessibilityLabel={failed ? 'Close sign-in' : 'Cancel sign-in'} hitSlop={8}
                style={({ pressed }) => [parts.pill, pressed && parts.pillPressed]}>
                <Text style={parts.pillText}>{cancelling ? 'Cancelling…' : failed ? 'Close' : 'Cancel'}</Text>
            </Pressable>
        </Animated.View>
    );
}

/** Step three: a name the person will recognise, suggested from the email. */
export function NameAccountSheet() {
    const { theme } = useUnistyles();
    const naming = useFlows((state) => state.naming);
    const connection = planConnection();
    const list = usePlansStore((state) => state.list);
    const [name, setName] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const account = naming?.account;
    // Every other account of this provider holds a name, signed in or not.
    const others = React.useMemo(
        () => (providerEntry(list, account?.provider ?? null)?.accounts ?? []).filter((other) => other.id !== account?.id),
        [list, account],
    );
    const suggestions = React.useMemo(
        () => (account === undefined ? [] : nameSuggestions(account, others.map((other) => other.name))),
        [account, others],
    );
    React.useEffect(() => {
        setSaving(false);
        setName(naming?.again ? naming.account.name : suggestions[0] ?? '');
        // Only when a new account arrives, never while typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [naming]);
    // The row stays marked while it is being named, then a moment longer.
    const landed = useFlows((state) => state.landed);
    React.useEffect(() => {
        if (landed === null || naming !== null) return;
        const timer = setTimeout(() => useFlows.setState({ landed: null }), LANDED_MS);
        return () => clearTimeout(timer);
    }, [landed, naming]);
    const close = () => useFlows.setState({ naming: null });
    if (account === undefined) return <OptionSheet visible={false} title="" options={[]} onSelect={() => {}} onClose={close} body={<View />} />;
    const trimmed = name.trim();
    const save = async () => {
        if (trimmed === '' || saving || useFlows.getState().naming !== naming || !samePlanConnection(connection)) return;
        setSaving(true);
        try {
            // A new account's name is only a suggestion until saved.
            if (trimmed !== account.name || !naming?.again) await renameAccount(account.id, trimmed, connection);
            if (!samePlanConnection(connection)) return;
            close();
            // The names the list below shows, read from the host's own list after
            // the save: the name just typed can collide, and the host gives the
            // other account its own name for it.
            const saved = providerEntry(usePlansStore.getState().list, account.provider);
            const names = (saved?.accounts.map((one) => one.name) ?? [trimmed]).sort();
            showNotice(naming?.again ? `${trimmed} is signed in` : `Added ${trimmed}`, `${providerName(account.provider)} accounts: ${names.join(', ')}`);
        } catch (error) {
            if (!samePlanConnection(connection)) return;
            setSaving(false);
            Modal.alert("Couldn't save the name", planFailure(error));
        }
    };
    const everyone = [...others.map((other) => other.name), trimmed || 'this one'].sort();
    return (
        <OptionSheet
            visible
            title=""
            options={[]}
            onSelect={() => {}}
            onClose={close}
            body={
                <View>
                    <SheetTitle>{naming?.again ? 'Signed in again' : 'Name this account'}</SheetTitle>
                    <SheetLede>
                        Signed in as {account.email ? <Strong>{account.email}</Strong> : 'a new account'}
                        {account.plan ? ` · ${providerName(account.provider)} ${account.plan}` : ''}
                    </SheetLede>
                    <TextInput
                        value={name}
                        onChangeText={setName}
                        onSubmitEditing={() => void save()}
                        autoFocus
                        maxLength={40}
                        returnKeyType="done"
                        placeholder="Work, Personal, a client…"
                        placeholderTextColor={theme.colors.textSecondary}
                        selectionColor={theme.colors.textLink}
                        accessibilityLabel="Account name"
                        style={styles.field}
                    />
                    <View style={styles.chips}>
                        {suggestions.map((suggestion) => (
                            <Pressable key={suggestion} onPress={() => setName(suggestion)} accessibilityRole="button" accessibilityLabel={`Name it ${suggestion}`}>
                                {({ pressed }) => <View style={pressed && parts.pillPressed}><Pill label={suggestion} /></View>}
                            </Pressable>
                        ))}
                    </View>
                    {everyone.length > 1 && (
                        <View style={styles.gapTop}>
                            <Note icon="sparkles-outline">
                                Auto will now choose between {everyone.map((one, index) => (
                                    <React.Fragment key={one}>
                                        {index === 0 ? '' : index === everyone.length - 1 ? ' and ' : ', '}
                                        <Strong>{one}</Strong>
                                    </React.Fragment>
                                ))} when you start {AGENTS[account.provider]}.
                            </Note>
                        </View>
                    )}
                    <PrimaryButton label={saving ? 'Saving…' : 'Save'} busy={saving || trimmed === ''} onPress={() => void save()} />
                </View>
            }
        />
    );
}

const LANDED_MS = 4_000;

/** A confirmation at the top: "Moved to Work", "Added Work", "Started on
 *  Work". It reads the app theme it is shown in, so changing the theme while it
 *  is up repaints it rather than leaving it in the palette it arrived with, and
 *  it stays up until a tap or the next notice. It carries its own surface and
 *  lets touches past its own corners, so it neither fights the screen under it
 *  nor hides one. */
export function Notice({ top }: { top: number }) {
    const { theme } = useUnistyles();
    const notice = useFlows((state) => state.notice);
    if (notice === null) return null;
    return (
        <Animated.View
            entering={FadeInUp.duration(180).reduceMotion(ReduceMotion.System)}
            exiting={FadeOutUp.duration(160).reduceMotion(ReduceMotion.System)}
            style={[styles.banner, { top }]}
            pointerEvents="box-none"
            accessibilityLiveRegion="polite"
        >
            <Ionicons name="checkmark-circle" size={24} color={theme.colors.success} />
            <Pressable style={parts.rowCopy} onPress={() => useFlows.setState({ notice: null })} accessibilityRole="button" accessibilityLabel={`${notice.title}. ${notice.detail}`}>
                <Text style={styles.bannerTitle}>{notice.title}</Text>
                <Text style={parts.facts} numberOfLines={2}>{notice.detail}</Text>
            </Pressable>
        </Animated.View>
    );
}

const styles = StyleSheet.create((theme) => ({
    step: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingHorizontal: 20,
        paddingVertical: 8,
    },
    num: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    numText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    stepTitle: {
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.text,
        ...Typography.default(),
    },
    banner: {
        position: 'absolute',
        left: 16,
        right: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 14,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: '#000',
        shadowOpacity: 0.25,
        shadowRadius: 15,
        shadowOffset: { width: 0, height: 8 },
        elevation: 10,
    },
    opening: {
        fontSize: 13,
        lineHeight: 18,
        textAlign: 'center',
        paddingHorizontal: 24,
        paddingTop: 10,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    bannerTitle: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    field: {
        marginHorizontal: 16,
        marginTop: 4,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1.5,
        borderColor: theme.colors.textLink,
        backgroundColor: theme.colors.surfaceHigh,
        color: theme.colors.text,
        fontSize: 16,
        ...Typography.default(),
        // The field's own border is the focus mark; no browser ring over it.
        outlineWidth: 0,
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 10,
    },
    gapTop: {
        marginTop: 8,
    },
}));
