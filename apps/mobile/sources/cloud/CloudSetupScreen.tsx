import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { claim, errorWords, MachineError, words } from '@byokit/cloud';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionButton } from '@/components/ActionButton';
import { Switch } from '@/components/Switch';
import { useRouter } from 'expo-router';
import { useAuth } from '@/account/ui';
import { pairLinkOffer } from '@/pairing';
import { getNativeSecret, setNativeSecret } from '@/pairing/secrets';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { Typography } from '@/constants/Typography';
import { OnboardingStepHeader } from '@/components/OnboardingStepHeader';
import { WordWrappingText } from '@/components/WordWrappingText';
import { BOAT_API, BOAT_KEY, BOAT_PRICES, deployBoatComputer, pendingBoatSize, PRICE, type BoatSize, type DeployStep } from './deployBoatComputer';

/**
 * What the Create and pair step shows as it runs, one line per phase in order. The phase running now reads the
 * deploy's own words; the screen phase shows only when that switch is on.
 */
const PHASES: { steps: DeployStep['step'][]; title: string; screenOnly?: boolean }[] = [
    { steps: ['creating'], title: 'Creating your cloud machine on Boat.' },
    { steps: ['starting'], title: 'Starting your cloud machine.' },
    { steps: ['installing', 'configuring'], title: 'Installing muxr.' },
    { steps: ['screen'], title: 'Adding a screen for sign-ins.', screenOnly: true },
    { steps: ['connecting'], title: 'Connecting over a private SSH link.' },
    { steps: ['pairing'], title: 'Pairing.' },
];
const SIZES: { id: BoatSize; title: string }[] = [{ id: 'small', title: 'Small · 2 CPUs, 4 GB' }, { id: 'default', title: 'Standard · 4 CPUs, 8 GB' }];
const STEP_WORDS: Record<DeployStep['step'], string> = {
    creating: 'Creating your cloud machine on Boat.',
    starting: 'Starting your cloud machine.',
    installing: 'Installing muxr on your cloud machine.',
    configuring: 'Setting up muxr on your cloud machine.',
    screen: 'Adding a screen for sign-ins. This takes a few minutes.',
    connecting: 'Connecting this phone to your cloud machine over a private SSH link.',
    pairing: words('setup.pairing', { app: 'muxr' }),
};
let deployRun: Promise<void> | undefined;
/** The deploy's latest step outlives the screen, so coming back to it shows where setup is. */
let deployStep: DeployStep | undefined;
/** Longer than Boat's sign-in code lives, so a person who is still typing it is never cut off; a lost connection still ends. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const SIGN_IN_TIMEOUT = 'Boat did not finish signing in within 10 minutes. Try again.';
/** Below this width in text units (window width over font scale) the screen switch gets a line of its own, so no word beside it is cut. */
const SWITCH_BESIDE_TITLE_MIN = 330;
const perHour = (size: BoatSize) => `$${BOAT_PRICES.find((p) => p.size === size)?.perHour} an hour while on`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const checkedLabel = (iso: string) => {
    const [year, month, day] = iso.split('-');
    return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
};

function failureText(cause: unknown): string {
    if (cause instanceof MachineError && cause.code === 'exists') return 'Your first size choice is kept. Try again with that size.';
    if (cause instanceof MachineError) return errorWords(cause, { app: 'muxr', label: 'Boat' });
    return cause instanceof Error ? cause.message : String(cause);
}

type ClaimFailure = Extract<Awaited<ReturnType<typeof claim> extends AsyncIterable<infer T> ? T : never>, { step: 'failed' }>['why'];

function failureMessage(why: ClaimFailure): string {
    switch (why) {
        case 'refused': return words('claim.refused', { label: 'Boat' });
        case 'expired': return words('claim.expired');
        case 'unreachable': return 'Could not reach Boat. Check your connection and try again.';
        case 'provider': return 'Boat could not complete sign-in. Try again.';
    }
}

export function CloudSetupScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const viewport = useWindowDimensions();
    const switchBeside = viewport.width / viewport.fontScale >= SWITCH_BESIDE_TITLE_MIN;
    const [email, setEmail] = React.useState('');
    const [url, setUrl] = React.useState<string>();
    const [code, setCode] = React.useState<string>();
    const [busy, setBusy] = React.useState(deployRun !== undefined);
    const [connected, setConnected] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const controller = React.useRef<AbortController | undefined>(undefined);
    const mounted = React.useRef(true);
    const [size, setSize] = React.useState<BoatSize>('small');
    const [sizeLocked, setSizeLocked] = React.useState(false);
    const [screen, setScreen] = React.useState(false);
    const [deploy, setDeploy] = React.useState<DeployStep | undefined>(deployStep);
    const auth = useAuth();
    const router = useRouter();

    const keepPendingSize = React.useCallback(() => {
        void pendingBoatSize().then((pending) => {
            if (!mounted.current) return;
            setSizeLocked(pending !== undefined);
            if (pending !== undefined) setSize(pending);
        }).catch(() => undefined);
    }, []);

    const settle = React.useCallback(async (run: Promise<void>) => {
        try {
            await run;
            if (mounted.current) router.replace('/');
        } catch (cause) {
            if (mounted.current) {
                setError(failureText(cause));
                setBusy(false);
                keepPendingSize();
            }
        }
    }, [router, keepPendingSize]);

    React.useEffect(() => {
        mounted.current = true;
        if (deployRun) void settle(deployRun);
        keepPendingSize();
        return () => {
            mounted.current = false;
            controller.current?.abort();
        };
    }, [settle, keepPendingSize]);
    React.useEffect(() => { void getNativeSecret(BOAT_KEY).then((key) => { if (key) setConnected(true); }); }, []);

    const create = React.useCallback(() => {
        if (deployRun) return;
        setBusy(true);
        setError(undefined);
        const run = deployBoatComputer({
            size,
            screen,
            onStep: (s) => {
                deployStep = s;
                if (mounted.current) setDeploy(s);
            },
            pair: async (offer, tunnelPort, deliverWords) => {
                if (!(await pairLinkOffer(offer, auth, { tunnelPort, confirm: async () => true, onWords: deliverWords }))) throw new Error('Pairing with your cloud machine failed. Try again.');
            },
        }).finally(() => {
            deployRun = undefined;
            deployStep = undefined;
        });
        deployRun = run;
        void settle(run);
    }, [size, screen, auth, settle]);
    // Option A's three steps: the Boat account, the size, then create and pair.
    const current = deploy ? 3 : connected ? 2 : 1;

    const connect = React.useCallback(async () => {
        const address = email.trim();
        if (!address) {
            setError('Enter the email address for your Boat account.');
            return;
        }
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        setBusy(true);
        setError(undefined);
        setUrl(undefined);
        setCode(undefined);
        let timedOut = false;
        const deadline = setTimeout(() => {
            timedOut = true;
            abort.abort();
        }, SIGN_IN_TIMEOUT_MS);
        try {
            for await (const step of claim({ baseUrl: BOAT_API, email: address, signal: abort.signal })) {
                if (abort.signal.aborted) break;
                if (step.step === 'open-page') setUrl(step.url);
                if (step.step === 'type-code') {
                    setUrl(step.url);
                    setCode(step.code);
                }
                if (step.step === 'failed') throw new Error(failureMessage(step.why));
                if (step.step === 'done') {
                    await setNativeSecret(BOAT_KEY, step.key);
                    setConnected(true);
                    setBusy(false);
                }
            }
            if (timedOut) throw new Error(SIGN_IN_TIMEOUT);
        } catch (cause) {
            if (timedOut || !abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            clearTimeout(deadline);
            if (timedOut || !abort.signal.aborted) setBusy(false);
        }
    }, [email]);

    if (Platform.OS === 'web') {
        return <View style={styles.webNotice}><WordWrappingText fontSize={24} lineHeight={30} style={styles.heading} accessibilityRole="header">Your cloud machine</WordWrappingText><Text style={styles.body}>Set up from the muxr phone app.</Text></View>;
    }

    const phase = deploy === undefined ? -1 : PHASES.findIndex((p) => p.steps.includes(deploy.step));
    return (
        <ScrollView style={{ marginBottom: insets.bottom }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {current === 1 && (
                <>
                    <OnboardingStepHeader step={1} of={3} time="about 1 min" title="Connect your Boat account" subtitle="No Tailscale needed. Boat bills you; muxr doesn’t." />
                    <View style={styles.card}>
                        <Text style={styles.label}>Boat account email</Text>
                        <TextInput
                            accessibilityLabel="Boat account email"
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="email-address"
                            placeholder="Email address"
                            placeholderTextColor={theme.colors.textSecondary}
                            value={email}
                            onChangeText={setEmail}
                            style={styles.input}
                        />
                        {!url ? (
                            <ActionButton title="Connect Boat account" icon="link-outline" disabled={busy} onPress={() => { void connect(); }} wrap />
                        ) : (
                            <ActionButton title="Sign in to Boat" icon="link-outline" onPress={() => { void openExternalUrl(url, { freshPage: true }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }} wrap />
                        )}
                        <Text style={styles.detail}>Boat opens in your browser. Type the code shown here, approve muxr there, then come back to this screen.</Text>
                        {url && code && <Text selectable style={styles.code}>Code · {code}</Text>}
                        {busy && <View style={styles.waiting}><ActivityIndicator /><Text style={styles.detail}>Waiting for Boat…</Text></View>}
                        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
                        {!busy && error && <ActionButton title="Try again" variant="secondary" onPress={() => { void connect(); }} />}
                    </View>
                    <Pressable accessibilityRole="link" onPress={() => { void openExternalUrl('https://boat.dev', { freshPage: true }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}>
                        <Text style={styles.createAccount}>No Boat account? Create one</Text>
                    </Pressable>
                </>
            )}
            {current === 2 && (
                <>
                    <OnboardingStepHeader step={2} of={3} time="about 15 s" title="Pick a size" subtitle="Boat account connected. Boat bills per second while it’s on." />
                    {SIZES.map((option) => (
                        <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: size === option.id }} disabled={busy || sizeLocked} onPress={() => setSize(option.id)} style={[styles.size, size === option.id && styles.sizeChosen]}>
                            <Text style={styles.stepTitle}>{option.title}</Text>
                            <Text style={styles.detail}>{perHour(option.id)}</Text>
                        </Pressable>
                    ))}
                    <Pressable accessibilityRole="switch" accessibilityLabel="Add a screen for sign-ins" accessibilityState={{ checked: screen, disabled: busy }} disabled={busy} onPress={() => setScreen((on) => !on)} style={styles.size}>
                        <View style={switchBeside ? styles.option : styles.optionStacked}>
                            <Text style={[styles.stepTitle, switchBeside && styles.grow]}>Add a screen for sign-ins</Text>
                            <Switch value={screen} disabled={busy} onValueChange={setScreen} />
                        </View>
                        <Text style={styles.detail}>For a sign-in that needs a browser: see and use it in Computer. Adds a few minutes, so leave it off for the fastest start.</Text>
                    </Pressable>
                    <Text style={styles.detail}>{`Paid to Boat, not muxr. Free while asleep; Boat's plan is at least $${PRICE.planFloorPerMonth} a month. Prices checked ${checkedLabel(PRICE.checked)}.`}</Text>
                    {busy && <Text style={styles.detail}>Setup is still running.</Text>}
                    <ActionButton title="Create cloud machine" icon="cloud-outline" disabled={busy} onPress={() => { void create(); }} wrap />
                    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
                </>
            )}
            {current === 3 && deploy && (
                <>
                    <OnboardingStepHeader step={3} of={3} time="usually 2–5 min" title="Create and pair" subtitle="muxr creates it, installs muxr, connects over a private SSH link and pairs. Keep this screen open." />
                    <View style={styles.card}>
                        {PHASES.filter((p) => !p.screenOnly || screen || deploy.step === 'screen').map((p) => {
                            const index = PHASES.indexOf(p);
                            const done = index < phase;
                            const now = index === phase;
                            return (
                                <View key={p.title} style={styles.phase}>
                                    {now && busy ? <ActivityIndicator /> : <Ionicons name={done ? 'checkmark' : 'ellipse-outline'} size={16} color={done ? theme.colors.status.connected : theme.colors.textSecondary} />}
                                    <Text style={[styles.detail, styles.grow, (done || now) && styles.phaseOn]}>{now ? STEP_WORDS[deploy.step] : p.title}</Text>
                                </View>
                            );
                        })}
                    </View>
                    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
                    {!busy && error && <ActionButton title="Try again" variant="secondary" onPress={() => { void create(); }} />}
                    <Text style={styles.detail}>Then you land on Home. Start an agent there, about 30 s, and it opens in a terminal on the cloud machine.</Text>
                </>
            )}
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    content: { alignSelf: 'center', width: '100%', maxWidth: 440, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 32, gap: 16 },
    webNotice: { flex: 1, padding: 24, gap: 12, justifyContent: 'center' },
    heading: { ...Typography.default('semiBold'), fontSize: 24, lineHeight: 30, color: theme.colors.text },
    card: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, padding: 14, gap: 10 },
    label: { ...Typography.default('semiBold'), fontSize: 14, color: theme.colors.text },
    grow: { flex: 1, minWidth: 0 },
    stepTitle: { ...Typography.default('semiBold'), flexShrink: 1, fontSize: 15, color: theme.colors.text },
    detail: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    body: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
    input: { ...Typography.default(), minHeight: 50, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12, paddingHorizontal: 14, color: theme.colors.text, backgroundColor: theme.colors.surfaceHighest, fontSize: 16 },
    code: { ...Typography.default('semiBold'), fontSize: 18, letterSpacing: 2, color: theme.colors.text, textAlign: 'center', padding: 8 },
    waiting: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    error: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.status.disconnected },
    size: { gap: 2, padding: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12 },
    option: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    optionStacked: { alignItems: 'flex-start', gap: 8 },
    sizeChosen: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surfaceHighest },
    phase: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 22 },
    phaseOn: { color: theme.colors.text },
    createAccount: { ...Typography.default('semiBold'), paddingVertical: 12, textAlign: 'center', color: theme.colors.textSecondary },
}));
