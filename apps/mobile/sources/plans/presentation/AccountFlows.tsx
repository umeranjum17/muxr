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
import { navigateToSession } from '@/herd';
import { Modal } from '@/modal';
import { nameSuggestions, providerEntry, providerName, type PlanAccount } from '../domain/planAccounts';
import { planConnection, samePlanConnection, refreshPlans, usePlansStore } from '../application/plansStore';
import { cancelSignIn, planFailure, renameAccount, signInState, startSignIn } from '../application/plansApi';
import { GhostButton, Note, Pill, PrimaryButton, SheetLede, SheetTitle, Strong, styles as parts } from './accountParts';

const TOOL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const AGENTS: Record<string, string> = { claude: 'Claude Code or Pi on a Claude model', codex: 'Codex' };

interface Pending { accountId: string; sessionId: string; provider: string; again: boolean; cancelled?: boolean }

interface FlowState {
    adding: string | null;
    pending: Pending | null;
    naming: { account: PlanAccount; again: boolean } | null;
    /** `overSession`: it lands on an agent screen, so it reads that screen's dark theme. */
    notice: { title: string; detail: string; overSession?: boolean } | null;
}

export const useFlows = create<FlowState>()(() => ({ adding: null, pending: null, naming: null, notice: null }));

let opening: { cancelled: boolean } | null = null;

usePlansStore.subscribe((state, previous) => {
    if (state.connection === previous.connection) return;
    opening = null;
    useFlows.setState({ adding: null, pending: null, naming: null, notice: null });
});

const seen = new MMKV();
const termsKey = (provider: string) => `plans-terms-seen:${provider}`;

export function showNotice(title: string, detail: string, overSession = false): void {
    useFlows.setState({ notice: { title, detail, overSession } });
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
                const pending = { ...started, provider, again: account !== undefined };
                if (attempt.cancelled) {
                    useFlows.setState({ pending: { ...pending, cancelled: true } });
                    await cancelSignIn(started.accountId, connection);
                    if (!samePlanConnection(connection)) return;
                    if (useFlows.getState().pending?.accountId === started.accountId) useFlows.setState({ pending: null });
                    return;
                }
                useFlows.setState({ adding: null, pending });
                leave?.();
                navigateToSession(router, started.sessionId);
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
                    {step(1, `${name}'s own sign-in opens in a new tab`, `The real ${TOOL[provider]}, in a fresh space just for this account.`)}
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
                    <GhostButton label="Cancel" onPress={close} />
                </View>
            }
        />
    );
}

const POLL_MS = 2_000;

/** Step two, on the sign-in tab itself: muxr waits for the tool to report
 *  signed in, then moves on by itself. */
export function SignInBanner({ bottom }: { bottom: number }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pending = useFlows((state) => state.pending);
    const connection = planConnection();
    const [cancelling, setCancelling] = React.useState(false);
    React.useEffect(() => { setCancelling(false); }, [connection]);
    const path = usePathname();
    const pathRef = React.useRef(path);
    pathRef.current = path;
    const here = pending !== null && decodeURIComponent(path) === `/session/${pending.sessionId}`;

    React.useEffect(() => {
        if (pending === null || pending.cancelled) return;
        let stopped = false;
        const tick = async () => {
            if (!samePlanConnection(connection) || useFlows.getState().pending !== pending) return;
            const account = await signInState(pending.accountId, connection).catch(() => null);
            if (!samePlanConnection(connection) || stopped || useFlows.getState().pending !== pending) return;
            if (account?.signedIn) {
                // The host has closed the tab: step back off it, then name the account.
                const sessionPath = `/session/${pending.sessionId}`;
                useFlows.setState({ pending: null, naming: { account, again: pending.again } });
                if (decodeURIComponent(pathRef.current) === sessionPath && router.canGoBack()) router.back();
                void refreshPlans();
                return;
            }
            timer = setTimeout(tick, POLL_MS);
        };
        let timer = setTimeout(tick, POLL_MS);
        return () => { stopped = true; clearTimeout(timer); };
    }, [pending, router, connection]);

    if (pending === null || (!here && !pending.cancelled)) return null;
    const cancel = async () => {
        if (cancelling || useFlows.getState().pending !== pending || !samePlanConnection(connection)) return;
        setCancelling(true);
        const cancelled = { ...pending, cancelled: true };
        useFlows.setState({ pending: cancelled });
        try {
            await cancelSignIn(pending.accountId, connection);
            if (!samePlanConnection(connection)) return;
            if (useFlows.getState().pending === cancelled) useFlows.setState({ pending: null });
            if (decodeURIComponent(pathRef.current) === `/session/${pending.sessionId}` && router.canGoBack()) router.back();
        } catch (error) {
            if (!samePlanConnection(connection)) return;
            Modal.alert("Couldn't cancel sign-in", planFailure(error));
        } finally {
            setCancelling(false);
        }
    };
    return (
        <Animated.View
            entering={FadeInDown.duration(180).reduceMotion(ReduceMotion.System)}
            exiting={FadeOutDown.duration(140).reduceMotion(ReduceMotion.System)}
            style={[styles.banner, { bottom }]}
            accessibilityLiveRegion="polite"
        >
            <Ionicons name="time-outline" size={20} color={theme.colors.textSecondary} />
            <View style={parts.rowCopy}>
                <Text style={styles.bannerTitle}>{pending.cancelled ? 'Sign-in cancellation pending' : 'Waiting for you to sign in'}</Text>
                <Text style={parts.facts}>This tab closes itself when you're signed in.</Text>
            </View>
            <Pressable disabled={cancelling} onPress={() => void cancel()} accessibilityRole="button" accessibilityLabel="Cancel sign-in" hitSlop={8}
                style={({ pressed }) => [parts.pill, pressed && parts.pillPressed]}>
                <Text style={parts.pillText}>{cancelling ? 'Cancelling…' : 'Cancel'}</Text>
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
    const others = React.useMemo(
        () => (providerEntry(list, account?.provider ?? null)?.accounts ?? []).filter((other) => other.id !== account?.id && other.signedIn),
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
            showNotice(naming?.again ? `${trimmed} is signed in` : `Added ${trimmed}`, `${providerName(account.provider)} accounts: ${[...others.map((other) => other.name), trimmed].sort().join(', ')}`);
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

const NOTICE_MS = 3_200;

/** A short confirmation at the top: "Moved to Work", "Added Work". */
export function Notice({ top }: { top: number }) {
    const { theme } = useUnistyles();
    const notice = useFlows((state) => state.notice);
    React.useEffect(() => {
        if (notice === null) return;
        const timer = setTimeout(() => useFlows.setState({ notice: null }), NOTICE_MS);
        return () => clearTimeout(timer);
    }, [notice]);
    if (notice === null) return null;
    return (
        <Animated.View
            entering={FadeInUp.duration(180).reduceMotion(ReduceMotion.System)}
            exiting={FadeOutUp.duration(160).reduceMotion(ReduceMotion.System)}
            style={[styles.banner, { top }]}
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
