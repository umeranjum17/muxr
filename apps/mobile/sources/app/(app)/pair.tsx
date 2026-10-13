import * as React from 'react';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Keyboard, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { KeyboardAwareScrollView, KeyboardEvents, KeyboardStickyView, type KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/account/ui';
import { decidePairingInput, linkPairMachineName, looksLikeLinkOffer, PairingNeedsNewCode } from '@/pairing/e2ee';
import { pairingDeviceNoun, pairLinkConsent, pairLinkOffer, usePairQrScannerAvailable, usePairQrScanner, resolvePairArrival, type PairArrivalSource, type PairingProgress } from '@/pairing';
import { applySshAfterPairing, establishSshTunnel, getCachedConnectionSettings, parseSshFields, sshTunnelAvailable, stopSshTunnel, type SshFieldInput } from '@/connection';
import { ActionButton } from '@/components/ActionButton';
import { WordWrappingText } from '@/components/WordWrappingText';
import { RouteSwitcher } from '@/herd/presentation/FirstRunConnection';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

// A cut-off or wrong-case offer still reaches review, which says why it cannot pair.
const carriesPairingOffer = (raw: string) => looksLikeLinkOffer(raw) || /byokit-link:/i.test(raw) || raw.includes('pair=');

// The success state is real, not a flash: it holds long enough to read before Home replaces it.
const PAIR_SUCCESS_HOLD_MS = 1200;

type PairState =
    | { phase: 'confirm'; url: string; machineName: string; linkOffer?: boolean }
    | { phase: 'working'; url: string; machineName: string; linkOffer?: boolean }
    | { phase: 'error'; message: string; url?: string; machineName?: string };

const SSH_PAIRING_STEPS = [
    'On the computer, run muxr pair — it prints a one-time link offer.',
    'Fill in the SSH details; muxr opens the tunnel to that machine.',
    'Paste the offer below — pairing runs through the tunnel.',
] as const;

function SshField(props: {
    testID: string;
    label: string;
    value: string;
    onChange: (next: string) => void;
    placeholder: string;
    secure?: boolean;
    multiline?: boolean;
    flex?: boolean;
    keyboardType?: 'default' | 'number-pad';
}) {
    return (
        <View style={[props.flex === true && styles.sshRowField, props.multiline === true && styles.sshFieldWide]}>
            <Text style={styles.inputLabel}>{props.label}</Text>
            <TextInput
                accessibilityLabel={props.label}
                testID={props.testID}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType={props.keyboardType ?? 'default'}
                multiline={props.multiline}
                numberOfLines={props.multiline ? 4 : 1}
                textAlignVertical={props.multiline ? 'top' : 'center'}
                secureTextEntry={props.secure === true && props.multiline !== true}
                placeholder={props.placeholder}
                placeholderTextColor={styles.inputPlaceholder.color}
                style={[styles.input, props.multiline === true && styles.inputMultiline]}
                value={props.value}
                onChangeText={props.onChange}
            />
        </View>
    );
}

export default function PairScreen() {
    const auth = useAuth();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    // Under ~200 text-scaled dp (208 dp at font 2.0) the card's padding left a
    // word no room at a readable size; tighten it rather than shrink the words.
    const { width, fontScale } = useWindowDimensions();
    const narrow = width / fontScale < 200;
    const [state, setState] = React.useState<PairState | undefined>(undefined);
    const [progress, setProgress] = React.useState<PairingProgress>();
    const [pairingValue, setPairingValue] = React.useState('');
    // After a failed code the one way on is Paste the new code; the field comes
    // back only when that paste fails (no clipboard access, or no code on it).
    const [pasteFailed, setPasteFailed] = React.useState(false);
    // The SSH-fluent route from the first-run chooser: the existing Direct SSH
    // fields open immediately, before any QR. Pairing itself is unchanged —
    // these details only decide which route the bytes take afterwards.
    const [sshHost, setSshHost] = React.useState('');
    const [sshUsername, setSshUsername] = React.useState('');
    const [sshPort, setSshPort] = React.useState('22');
    const [sshRelayPort, setSshRelayPort] = React.useState('8792');
    const [sshPassword, setSshPassword] = React.useState('');
    const [sshPrivateKey, setSshPrivateKey] = React.useState('');
    const [sshPassphrase, setSshPassphrase] = React.useState('');
    const [sshError, setSshError] = React.useState<string | undefined>(undefined);
    const [commandCopied, setCommandCopied] = React.useState(false);
    // Hold the check mark on screen so the success is real, never a spinner that
    // vanishes into Home. Cleared on unmount so leaving early cancels it.
    const successTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => { if (successTimer.current !== undefined) clearTimeout(successTimer.current); }, []);
    // The hero icon has no room once the keyboard takes half the screen: it
    // renders cut off under the header. Hide it while the keyboard is open
    // instead of showing a clipped badge. Closed is the scroll view's own hide
    // event: it lands after its last scroll restore, React Native's lands before.
    const [keyboardOpen, setKeyboardOpen] = React.useState(false);
    React.useEffect(() => {
        const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
        const hide = KeyboardEvents.addListener('keyboardDidHide', () => setKeyboardOpen(false));
        return () => { show.remove(); hide.remove(); };
    }, []);
    // Native intent routes the offer into this screen's query param before Expo Router handles the URL.
    const routeParams = useLocalSearchParams();
    const browser = Platform.OS === 'web';
    const PairScrollView = browser ? ScrollView : KeyboardAwareScrollView;
    // Rides on the keyboard on both native platforms: Android's window does
    // not resize under the keyboard provider, so a plain bar sat behind it.
    const ConnectBar = browser ? View : KeyboardStickyView;
    // The open keyboard already covers the bottom inset; keeping it would
    // lift the bar and cut that much off a 270dp viewport.
    const connectBarOffset = browser ? {} : { offset: { opened: insets.bottom } };
    const openedFromSettings = routeParams.source === 'settings';
    const sshRoute = !browser && routeParams.route === 'ssh' && sshTunnelAvailable();
    // pairArrival.ts owns intent restoration; typed, pasted and scanned input
    // stays on the normal consent/error path.
    const reviewPairing = React.useCallback((raw: string, source: PairArrivalSource = 'user') =>
        resolvePairArrival(raw, { authenticated: auth.isAuthenticated, source }).then((target) => {
            if (target === 'home') {
                router.replace('/');
                return;
            }
            const decided = decidePairingInput(raw);
            if (!decided.ok) {
                // Empty the field: a new code pasted after the dead one would
                // join onto it and read as cut off.
                setPairingValue('');
                setState({ phase: 'error', message: decided.message });
                return;
            }
            // `link` is what pairing accepts: the HTTPS wrapper for a browser
            // link (the web guard requires it), the inner offer otherwise.
            const link = decided.link;
            setState({ phase: 'confirm', url: link, machineName: 'your computer', linkOffer: true });
            void linkPairMachineName(link).then((name) => {
                if (name !== undefined) setState((current) => current?.url === link ? { ...current, machineName: name } : current);
            }).catch(() => undefined);
        }).catch(() => undefined), [auth.isAuthenticated, router]);
    // Scan leads every native entry and error; a device with no camera
    // scanner leads with paste instead of a button that cannot open.
    const canScan = usePairQrScannerAvailable();
    const scanPairQr = usePairQrScanner(reviewPairing, canScan);
    const switching = getCachedConnectionSettings().machineId !== '';
    const routePairUrl = typeof routeParams.offer === 'string' && carriesPairingOffer(routeParams.offer)
        ? routeParams.offer : undefined;

    React.useEffect(() => {
        let cancelled = false;
        const receive = (raw: string | null) => {
            if (cancelled || !raw) return false;
            if (!carriesPairingOffer(raw)) return false;
            reviewPairing(raw, 'intent');
            return true;
        };
        if (routePairUrl !== undefined) {
            receive(routePairUrl);
            return undefined;
        }
        // Settings is deliberate manual entry, not a replay of the launching intent.
        if (!openedFromSettings) {
            void Linking.getInitialURL().then((url) => {
                if (cancelled) return;
                receive(url);
            }).catch((cause) => {
                if (!cancelled) setState({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) });
            });
        }
        // Warm start: the app was already open when the link arrived.
        const subscription = Linking.addEventListener('url', (event) => receive(event.url));
        return () => { cancelled = true; subscription.remove(); };
    }, [routePairUrl, browser, sshRoute, openedFromSettings, reviewPairing]);

    const pair = React.useCallback(async (url: string, sshInput?: SshFieldInput) => {
        // Link offers pair over the running machine; Direct SSH uses its own route.
        const decided = decidePairingInput(url);
        if (!decided.ok) throw new PairingNeedsNewCode(decided.message);
        const tunnel = sshInput === undefined ? undefined : await establishSshTunnel(sshInput);
        if (tunnel !== undefined && !tunnel.ok) throw new Error(tunnel.message);
        const paired = await pairLinkOffer(decided.link, auth, {
            tunnelPort: tunnel?.ok ? tunnel.localPort : undefined,
            confirm: async () => true,
            onProgress: setProgress,
        });
        if (!paired) {
            if (tunnel !== undefined) await stopSshTunnel();
            return;
        }
        if (sshInput !== undefined && tunnel?.ok) {
            const applied = await applySshAfterPairing(sshInput, { hostKey: tunnel.hostKey });
            if (!applied.ok) Modal.alert('Paired — SSH route not applied', applied.message);
        }
        // Show the check mark for a beat, then Home; the timer is cleared on unmount.
        successTimer.current = setTimeout(() => router.replace('/'), PAIR_SUCCESS_HOLD_MS);
    }, [auth, router]);

    const sshInput = React.useCallback((): { ok: true; input?: SshFieldInput } | { ok: false; error: string } => {
        if (!sshRoute) return { ok: true };
        const input: SshFieldInput = {
            host: sshHost,
            username: sshUsername,
            port: sshPort,
            relayPort: sshRelayPort,
            password: sshPassword,
            privateKey: sshPrivateKey,
            passphrase: sshPassphrase,
        };
        // Fields left completely empty mean the user only wants the plain
        // pairing; anything filled must parse before a claim is attempted.
        const filled = [input.host, input.username, input.password, input.privateKey, input.passphrase].some((v) => v.trim() !== '');
        if (!filled) return { ok: true };
        const parsed = parseSshFields(input);
        if ('error' in parsed) return { ok: false, error: parsed.error };
        return { ok: true, input };
    }, [sshRoute, sshHost, sshUsername, sshPort, sshRelayPort, sshPassword, sshPrivateKey, sshPassphrase]);

    const confirm = React.useCallback(() => {
        if (state === undefined || (state.phase !== 'confirm' && state.phase !== 'error') || state.url === undefined) return;
        const parsedInput = sshInput();
        if (!parsedInput.ok) {
            setSshError(parsedInput.error);
            setState(undefined);
            return;
        }
        const { url, machineName } = state;
        setProgress(undefined);
        setState({ phase: 'working', url, machineName: machineName ?? 'this machine' });
        void pair(url, parsedInput.input).catch((cause) => {
            // A spent code drops to the new-code form; anything else keeps Try again on this code.
            if (cause instanceof PairingNeedsNewCode) setPairingValue('');
            setState({
                phase: 'error',
                message: cause instanceof Error ? cause.message : String(cause),
                ...(cause instanceof PairingNeedsNewCode ? {} : { url, machineName }),
            });
        });
    }, [state, pair, sshInput]);

    // A complete code pasted and Connect tapped at once must review it once.
    const submitting = React.useRef(false);
    const submitManual = React.useCallback((raw: string) => {
        if (submitting.current) return;
        setSshError(undefined);
        const parsedInput = sshInput();
        if (!parsedInput.ok) {
            setSshError(parsedInput.error);
            return;
        }
        submitting.current = true;
        Keyboard.dismiss();
        void reviewPairing(raw).finally(() => { submitting.current = false; });
    }, [sshInput, reviewPairing]);
    const connectManual = React.useCallback(() => submitManual(pairingValue), [submitManual, pairingValue]);
    // A complete code goes straight to review, and so does one that has run
    // out, which says so at once; a partial one waits for Connect, which names
    // what is wrong. SSH waits: its fields are not filled yet.
    const changePairingValue = React.useCallback((next: string) => {
        setPairingValue(next);
        const decided = decidePairingInput(next);
        if (!sshRoute && (decided.ok || decided.expired)) submitManual(next);
    }, [sshRoute, submitManual]);
    // One tap after a failed code: the computer already shows a fresh one.
    const pasteNewCode = React.useCallback(() => {
        void Clipboard.getStringAsync().then((text) => {
            if (!decidePairingInput(text).ok) setPasteFailed(true);
            setPairingValue(text);
            submitManual(text);
        }, (cause: unknown) => {
            setPasteFailed(true);
            setState({ phase: 'error', message: `Couldn't read the clipboard: ${cause instanceof Error ? cause.message : String(cause)}` });
        });
    }, [submitManual]);
    React.useEffect(() => { if (state?.phase !== 'error') setPasteFailed(false); }, [state?.phase]);

    const cancel = React.useCallback(() => {
        if (openedFromSettings) router.back();
        else router.replace('/');
    }, [openedFromSettings, router]);

    // The switcher's Fast pairing segment: from first-run, pop back to the
    // chooser; from a settings entry, the fast route lives on Home.
    const switchToFast = React.useCallback(() => {
        if (!openedFromSettings) router.back();
        else router.replace('/');
    }, [openedFromSettings, router]);

    const manualForm = state === undefined || state.phase === 'error' && state.url === undefined;
    const showField = state?.phase !== 'error' || sshRoute || pasteFailed;
    // An error leads the card, a screen above the field at a large font on a short phone: bring it into view
    // each time the keyboard closes, since the scroll view's own keyboard adjustment moves it away again (the
    // keyboard can open after the error lands). With the field back, only once, so closing it does not jump.
    const scrollRef = React.useRef<KeyboardAwareScrollViewRef>(null);
    const shownError = React.useRef<PairState>(undefined);
    React.useEffect(() => {
        if (state?.phase !== 'error' || keyboardOpen || (showField && shownError.current === state)) return;
        shownError.current = state;
        scrollRef.current?.scrollTo({ y: 0, animated: true });
    }, [state, keyboardOpen, showField]);
    return (
        <View style={styles.screenWrap}>
        <PairScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={[styles.screen, narrow && styles.narrowScreen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" {...(browser ? {} : { bottomOffset: 120 })}>
            <View style={[styles.hero, narrow && styles.narrowHero]}>
                {!keyboardOpen && (
                    <View style={styles.iconBadge}>
                        <Ionicons name="desktop-outline" size={30} color={styles.icon.color} />
                    </View>
                )}
                <WordWrappingText fontSize={26} lineHeight={32} style={styles.machineName}>
                    {state === undefined
                        ? 'Securely pair this device'
                        : state.machineName ?? 'Securely pair this device'}
                </WordWrappingText>
                {state?.phase === 'confirm' && (
                    <Text style={styles.subtitle}>wants to pair with this {pairingDeviceNoun()}</Text>
                )}
            </View>

            <View style={[styles.card, narrow && styles.narrowCard]}>
                {state?.phase === 'working' ? (
                    progress?.phase === 'paired' ? (
                        <View style={styles.successRow}>
                            <Ionicons name="checkmark-circle" size={28} color={styles.successIcon.color} />
                            <Text accessibilityLiveRegion="polite" style={styles.successText}>{t('pairing.paired', { name: state.machineName })}</Text>
                        </View>
                    ) : (
                        <>
                            <View style={styles.progressHead}>
                                <ActivityIndicator color={styles.progressText.color} />
                                <Text style={styles.progressText}>{t('pairing.busy')}</Text>
                            </View>
                            {progress?.words ? (
                                <>
                                    <Text accessibilityLiveRegion="polite" style={styles.stepText}>{t('pairing.compareWords', { name: state.machineName })}</Text>
                                    <WordWrappingText fontSize={26} lineHeight={32} selectable style={styles.machineName}>{progress.words}</WordWrappingText>
                                </>
                            ) : (
                                <Text accessibilityLiveRegion="polite" style={styles.stepText}>{t('pairing.connecting')}</Text>
                            )}
                        </>
                    )
                ) : state?.phase === 'confirm' ? (
                    <>
                        <View style={styles.grantList}>
                            {pairLinkConsent(state.url, state.machineName).map((line, index) => (
                                <View key={index} style={styles.grantRow}>
                                    <Text style={styles.grantBullet}>•</Text>
                                    <View style={styles.grantBody}>
                                        <Text style={styles.grantText}>{line.text}</Text>
                                        {line.command !== undefined && (
                                            <Text style={styles.grantCommand} selectable>{line.command.replace(/-/g, '\u2011')}</Text>
                                        )}
                                    </View>
                                </View>
                            ))}
                        </View>
                        {switching && (
                            <View style={styles.securityRow}>
                                <Ionicons name="swap-horizontal-outline" size={16} color={styles.securityText.color} />
                                <Text style={styles.securityText}>
                                    This device is already paired — pairing switches the active machine to this one. The previous pairing stays saved in Settings.
                                </Text>
                            </View>
                        )}
                        <ActionButton title="Pair" icon="link-outline" onPress={confirm} />
                        <ActionButton title="Cancel" variant="secondary" onPress={cancel} />
                    </>
                ) : state?.phase === 'error' && state.url !== undefined ? (
                    <>
                        <Text accessibilityRole="alert" style={styles.errorText}>{state.message}</Text>
                        <ActionButton title="Try again" icon="refresh-outline" onPress={confirm} />
                        {canScan && <ActionButton title="Scan a new code" variant="secondary" icon="qr-code-outline" wrap onPress={() => void scanPairQr()} />}
                        <ActionButton title="Enter another code" variant="secondary" icon="keypad-outline" wrap onPress={() => setState(undefined)} />
                        <ActionButton title="Back" variant="quiet" onPress={cancel} />
                    </>
                ) : (
                    <>
                        {state?.phase === 'error' && (
                            <Text accessibilityRole="alert" style={styles.errorText}>{state.message}</Text>
                        )}
                        {sshRoute && (
                            <>
                                <RouteSwitcher onFastPairing={switchToFast} />
                                <View style={styles.sshSteps}>
                                    {SSH_PAIRING_STEPS.map((step, index) => (
                                        <View key={step} style={styles.stepRow}>
                                            <Text style={styles.stepIndex}>{index + 1}</Text>
                                            <Text style={styles.stepText}>{step}</Text>
                                        </View>
                                    ))}
                                </View>
                                <View style={styles.commandRow}>
                                    <Text style={styles.command} selectable>muxr pair</Text>
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={commandCopied ? 'Copied' : 'Copy muxr pair'}
                                        hitSlop={10}
                                        style={styles.copyButton}
                                        onPress={() => {
                                            void Clipboard.setStringAsync('muxr pair').then(() => {
                                                setCommandCopied(true);
                                                setTimeout(() => setCommandCopied(false), 2000);
                                            }).catch(() => Modal.alert('Copy failed', 'Please try again.'));
                                        }}
                                    >
                                        <Ionicons name={commandCopied ? 'checkmark-outline' : 'copy-outline'} size={20} color={styles.inputPlaceholder.color} />
                                    </Pressable>
                                </View>
                                <SshField testID="ssh-host" label="SSH host" value={sshHost} onChange={setSshHost} placeholder="server.example.com or 192.168.1.20" />
                                <SshField testID="ssh-username" label="SSH username" value={sshUsername} onChange={setSshUsername} placeholder="your login on the machine" />
                                <View style={styles.sshRow}>
                                    <SshField flex testID="ssh-port" label="SSH port" value={sshPort} onChange={setSshPort} placeholder="22" keyboardType="number-pad" />
                                    <SshField flex testID="ssh-relay-port" label="Relay port" value={sshRelayPort} onChange={setSshRelayPort} placeholder="8792" keyboardType="number-pad" />
                                </View>
                                <SshField testID="ssh-password" label="SSH password (optional)" value={sshPassword} onChange={setSshPassword} placeholder="Password or private key" secure />
                                <SshField testID="ssh-private-key" label="Private key (optional)" value={sshPrivateKey} onChange={setSshPrivateKey} placeholder="Paste an OpenSSH private key" secure multiline />
                                <SshField testID="ssh-passphrase" label="Private key passphrase" value={sshPassphrase} onChange={setSshPassphrase} placeholder="Only if the key is encrypted" secure />
                            </>
                        )}
                        {canScan && !sshRoute && (
                            <>
                                <ActionButton title={state?.phase === 'error' ? 'Scan a new code' : 'Scan the QR'} icon="qr-code-outline" wrap onPress={() => void scanPairQr()} />
                                <Text style={styles.routeHint}>{state?.phase === 'error'
                                    ? 'On your computer, open muxr or run muxr\u00A0pair for a new code.'
                                    : `Open muxr on your computer, or run muxr\u00A0pair, then point this ${pairingDeviceNoun()} at the QR it shows.`}</Text>
                            </>
                        )}
                        {!browser && !canScan && !sshRoute && (
                            <Text style={styles.routeHint}>{`This ${pairingDeviceNoun()} can't scan a QR, so paste the pairing string muxr shows on your computer.`}</Text>
                        )}
                        {state?.phase === 'error' && !sshRoute && (
                            <ActionButton title="Paste the new code" icon="clipboard-outline" variant={canScan ? 'secondary' : 'primary'} wrap onPress={pasteNewCode} />
                        )}
                        {showField && (
                            <>
                                <WordWrappingText fontSize={14} style={styles.inputLabel}>{browser ? 'Pairing code' : sshRoute ? 'Pairing string from muxr pair' : canScan ? 'Or paste the pairing string' : 'Paste the pairing string'}</WordWrappingText>
                                <TextInput
                                    accessibilityLabel="Pairing string"
                                    testID={sshRoute ? "ssh-pairing-offer" : undefined}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="url"
                                    placeholder="Paste it here"
                                    placeholderTextColor={styles.inputPlaceholder.color}
                                    returnKeyType="go"
                                    style={styles.input}
                                    value={pairingValue}
                                    onChangeText={changePairingValue}
                                    onSubmitEditing={connectManual}
                                />
                                <WordWrappingText fontSize={13} lineHeight={18} style={styles.routeHint}>{browser
                                    ? 'Paste the pairing code from muxr on your computer.'
                                    : sshRoute
                                        ? `The string proves the machine consented; the SSH details decide how this ${pairingDeviceNoun()} reaches it.`
                                        : canScan
                                            ? `If you can't point this ${pairingDeviceNoun()} at that screen, copy the pairing string shown there.`
                                            : 'Copy it from muxr on your computer.'}</WordWrappingText>
                            </>
                        )}
                        <ActionButton title="Back" variant="quiet" onPress={cancel} />
                    </>
                )}
            </View>
        </PairScrollView>
        {sshRoute && manualForm && (
            // Anchored below the scroll; on native it follows the keyboard
            // without shrinking the aware scroll.
            <ConnectBar style={[styles.ctaBar, { paddingBottom: insets.bottom + 8 }]} {...connectBarOffset}>
                {sshError !== undefined && <Text accessibilityRole="alert" style={styles.errorText}>{sshError}</Text>}
                <ActionButton testID="ssh-connect" title="Connect" icon="link-outline" wrap disabled={!pairingValue.trim()} onPress={connectManual} />
            </ConnectBar>
        )}
        {!sshRoute && manualForm && showField && (
            // Same anchored bar as the SSH route: the manual Connect must stay
            // above the keyboard on short viewports.
            <ConnectBar style={[styles.ctaBar, { paddingBottom: insets.bottom + 8 }]} {...connectBarOffset}>
                <ActionButton title="Connect" icon="link-outline" variant={canScan ? 'secondary' : 'primary'} wrap disabled={!pairingValue.trim()} onPress={connectManual} />
            </ConnectBar>
        )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    scroll: {
        flex: 1,
    },
    screenWrap: {
        flex: 1,
    },
    screen: {
        flexGrow: 1,
        paddingHorizontal: 24,
        justifyContent: 'center',
        gap: 24,
    },
    narrowScreen: { paddingHorizontal: 8 },
    hero: {
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    narrowHero: { paddingHorizontal: 0 },
    iconBadge: {
        width: 64,
        height: 64,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        marginBottom: 20,
    },
    icon: {
        color: theme.colors.text,
    },
    machineName: {
        // Stretch so the whole title wraps inside the hero at the largest text,
        // never an ellipsized line measured wider than the screen.
        alignSelf: 'stretch',
        ...Typography.default('semiBold'),
        textAlign: 'center',
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 22,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        marginTop: 6,
    },
    card: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: 380,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 20,
        padding: 20,
        gap: 12,
    },
    narrowCard: { paddingHorizontal: 8 },
    securityRow: {
        flexDirection: 'row',
        gap: 10,
        alignItems: 'flex-start',
        paddingBottom: 8,
    },
    securityText: {
        ...Typography.default(),
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    progressHead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingBottom: 4,
    },
    progressText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text,
    },
    successRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 4,
    },
    successIcon: {
        color: theme.colors.success,
    },
    successText: {
        ...Typography.default('semiBold'),
        flex: 1,
        minWidth: 0,
        fontSize: 17,
        lineHeight: 23,
        color: theme.colors.text,
    },
    stepGroup: {
        gap: 8,
        paddingBottom: 4,
    },
    stepHeading: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    stepIndex: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 20,
        width: 18,
        height: 20,
        textAlign: 'center',
        overflow: 'hidden',
        borderRadius: 6,
        backgroundColor: theme.colors.surfaceHighest,
        color: theme.colors.textSecondary,
    },
    grantList: {
        gap: 8,
        alignSelf: 'stretch',
    },
    grantRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    grantBody: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    grantBullet: {
        width: 18,
        lineHeight: 20,
        textAlign: 'center',
        color: theme.colors.textSecondary,
    },
    grantCommand: {
        ...Typography.mono(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
    },
    grantText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text,
    },
    stepText: {
        ...Typography.default(),
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    inputLabel: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    input: {
        ...Typography.default(),
        height: 50,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
        color: theme.colors.text,
        paddingHorizontal: 14,
        fontSize: 16,
    },
    inputMultiline: {
        height: 'auto',
        minHeight: 90,
        paddingTop: 12,
    },
    sshFieldWide: {
        alignSelf: 'stretch',
    },
    sshRow: {
        flexDirection: 'row',
        alignSelf: 'stretch',
        gap: 10,
    },
    sshRowField: {
        flex: 1,
    },
    sshSteps: {
        alignSelf: 'stretch',
        gap: 8,
        paddingBottom: 4,
    },
    ctaBar: {
        alignSelf: 'stretch',
        borderTopWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 24,
        paddingTop: 10,
        gap: 8,
    },
    commandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'stretch',
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 14,
        height: 50,
    },
    command: {
        ...Typography.mono(),
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
    },
    copyButton: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inputPlaceholder: {
        color: theme.colors.textSecondary,
    },
    routeHint: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textDestructive,
        paddingBottom: 8,
    },
}));
