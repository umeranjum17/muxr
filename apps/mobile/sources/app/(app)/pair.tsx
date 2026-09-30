import * as React from 'react';
import * as Linking from 'expo-linking';
import { pairingView } from '@byokit/ui-core/link';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/account/ui';
import { LinkPairingRecoveryError, linkPairMachineName, looksLikeLinkOffer } from '@/pairing/e2ee';
import { pairLinkConsent, pairLinkOffer, usePairQrScanner, type PairingProgress } from '@/pairing';
import { applySshAfterPairing, establishSshTunnel, getCachedConnectionSettings, parseSshFields, sshTunnelAvailable, stopSshTunnel, type SshFieldInput } from '@/connection';
import { ActionButton } from '@/components/ActionButton';
import { RouteSwitcher } from '@/herd/presentation/FirstRunConnection';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';

type PairState =
    | { phase: 'confirm'; url: string; machineName: string; linkOffer?: boolean }
    | { phase: 'working'; url: string; machineName: string; linkOffer?: boolean }
    | { phase: 'error'; message: string; url?: string; machineName?: string };

const SSH_PAIRING_STEPS = [
    'On the computer, run `muxr pair` — it prints a one-time link offer.',
    'Fill in the SSH details; muxr opens the tunnel to that machine.',
    'Paste the offer below — pairing runs through the tunnel.',
] as const;

function SshField(props: {
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
    const [state, setState] = React.useState<PairState | undefined>(undefined);
    const [progress, setProgress] = React.useState<PairingProgress>();
    const [pairingValue, setPairingValue] = React.useState('');
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
    // Native intent routes the offer into this screen's query param before Expo Router handles the URL.
    const routeParams = useLocalSearchParams();
    const browser = Platform.OS === 'web';
    const PairScrollView = browser ? ScrollView : KeyboardAwareScrollView;
    const openedFromSettings = routeParams.source === 'settings';
    const sshRoute = !browser && routeParams.route === 'ssh' && Platform.OS === 'android' && sshTunnelAvailable();
    const reviewPairing = React.useCallback((raw: string) => {
        if (looksLikeLinkOffer(raw.trim())) {
            const offer = raw.trim();
            setState({ phase: 'confirm', url: offer, machineName: 'your computer', linkOffer: true });
            void linkPairMachineName(offer).then((name) => {
                if (name !== undefined) setState((current) => current?.url === offer ? { ...current, machineName: name } : current);
            }).catch(() => undefined);
            return;
        }
        setState({ phase: 'error', message: 'This pairing code is from an older muxr. Update muxr on both devices, run `muxr pair` on the computer, then scan its new link code.' });
    }, []);
    const scanPairQr = usePairQrScanner(reviewPairing, !browser && openedFromSettings);
    const switching = getCachedConnectionSettings().machineId !== '';
    const routePairUrl = typeof routeParams.offer === 'string' && looksLikeLinkOffer(routeParams.offer)
        ? routeParams.offer : undefined;

    React.useEffect(() => {
        let cancelled = false;
        const receive = (raw: string | null) => {
            if (cancelled || !raw) return false;
            if (!looksLikeLinkOffer(raw.trim())) {
                if (!raw.includes('byokit-link:') && !raw.includes('pair=')) return false;
                setState({ phase: 'error', message: 'This pairing code is from an older muxr. Run `muxr pair` on the computer for a new link code.' });
                return true;
            }
            reviewPairing(raw);
            return true;
        };
        if (routePairUrl !== undefined) {
            receive(routePairUrl);
            return undefined;
        }
        void Linking.getInitialURL().then((url) => {
            if (cancelled) return;
            receive(url);
        }).catch((cause) => {
            if (!cancelled) setState({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) });
        });
        // Warm start: the app was already open when the link arrived.
        const subscription = Linking.addEventListener('url', (event) => receive(event.url));
        return () => { cancelled = true; subscription.remove(); };
    }, [routePairUrl, browser, sshRoute, reviewPairing]);

    const pair = React.useCallback(async (url: string, sshInput?: SshFieldInput) => {
        // Link offers pair over the running machine; Direct SSH uses its own route.
        if (looksLikeLinkOffer(url.trim())) {
            const tunnel = sshInput === undefined ? undefined : await establishSshTunnel(sshInput);
            if (tunnel !== undefined && !tunnel.ok) throw new Error(tunnel.message);
            let paired: boolean;
            try {
                paired = await pairLinkOffer(url.trim(), auth, {
                    tunnelPort: tunnel?.ok ? tunnel.localPort : undefined,
                    confirm: async () => true,
                    onProgress: setProgress,
                });
            } catch (cause) {
                if (tunnel !== undefined) await stopSshTunnel();
                if (!(cause instanceof LinkPairingRecoveryError)) throw cause;
                router.replace(cause.recovery === 'saved' ? '/settings' : '/');
                return;
            }
            if (!paired) {
                if (tunnel !== undefined) await stopSshTunnel();
                // The claim already saved the grant and consumed the code;
                // recovery must use saved pairing rather than offer Pair again.
                router.replace('/settings');
                return;
            }
            if (sshInput !== undefined && tunnel?.ok) {
                const applied = await applySshAfterPairing(sshInput, { hostKey: tunnel.hostKey });
                if (!applied.ok) Modal.alert('Paired — SSH route not applied', applied.message);
            }
            router.replace('/');
            return;
        }
        throw new Error('This pairing code is from an older muxr. Run `muxr pair` on the computer for a new link code.');
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
            setState({
                phase: 'error',
                message: cause instanceof Error ? cause.message : String(cause),
                url,
                machineName,
            });
        });
    }, [state, pair, sshInput]);

    const connectManual = React.useCallback(() => {
        setSshError(undefined);
        const parsedInput = sshInput();
        if (!parsedInput.ok) {
            setSshError(parsedInput.error);
            return;
        }
        reviewPairing(pairingValue);
    }, [pairingValue, sshInput, reviewPairing]);

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
    return (
        <View style={styles.screenWrap}>
        <PairScrollView style={styles.scroll} contentContainerStyle={[styles.screen, { paddingBottom: insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled" {...(browser ? {} : { bottomOffset: 120 })}>
            <View style={styles.hero}>
                <View style={styles.iconBadge}>
                    <Ionicons name="desktop-outline" size={30} color={styles.icon.color} />
                </View>
                <Text style={styles.machineName} numberOfLines={2}>
                    {state === undefined
                        ? 'Securely pair this device'
                        : state.machineName ?? 'Securely pair this device'}
                </Text>
                {state?.phase === 'confirm' && (
                    <Text style={styles.subtitle}>wants to pair with this {browser ? 'browser' : 'phone'}</Text>
                )}
            </View>

            <View style={styles.card}>
                {state?.phase === 'working' ? (
                    <>
                        <View style={styles.progressHead}>
                            <ActivityIndicator color={styles.progressText.color} />
                            <Text style={styles.progressText}>Pairing…</Text>
                        </View>
                        <Text accessibilityLiveRegion="polite" style={styles.stepText}>{progress?.title ?? 'Connecting securely to your computer…'}</Text>
                        {progress?.words && <>
                            <Text selectable style={styles.machineName}>{progress.words}</Text>
                            <Text style={styles.stepText}>{pairingView({ phase: 'waiting', hostName: state.machineName, words: progress.words }).title}</Text>
                            <Text style={styles.routeHint}>Check both words match, then press y on the computer.</Text>
                        </>}
                    </>
                ) : state?.phase === 'confirm' ? (
                    <>
                        <Text style={styles.grantText}>{pairLinkConsent(state.url, state.machineName)}</Text>
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
                        <ActionButton title="Enter another code" icon="keypad-outline" onPress={() => setState(undefined)} />
                        <ActionButton title="Back" variant="secondary" onPress={cancel} />
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
                                <SshField label="SSH host" value={sshHost} onChange={setSshHost} placeholder="server.example.com or 192.168.1.20" />
                                <SshField label="SSH username" value={sshUsername} onChange={setSshUsername} placeholder="your login on the machine" />
                                <View style={styles.sshRow}>
                                    <SshField flex label="SSH port" value={sshPort} onChange={setSshPort} placeholder="22" keyboardType="number-pad" />
                                    <SshField flex label="Relay port" value={sshRelayPort} onChange={setSshRelayPort} placeholder="8792" keyboardType="number-pad" />
                                </View>
                                <SshField label="SSH password (optional)" value={sshPassword} onChange={setSshPassword} placeholder="Password or private key" secure />
                                <SshField label="Private key (optional)" value={sshPrivateKey} onChange={setSshPrivateKey} placeholder="Paste an OpenSSH private key" secure multiline />
                                <SshField label="Private key passphrase" value={sshPassphrase} onChange={setSshPassphrase} placeholder="Only if the key is encrypted" secure />
                            </>
                        )}
                        {!browser && openedFromSettings && !sshRoute && (
                            <>
                                <ActionButton title="Scan pairing QR" icon="qr-code-outline" onPress={() => void scanPairQr()} />
                                <Text style={styles.routeHint}>Recommended · ~1 min · for the computer in front of you.</Text>
                            </>
                        )}
                        {state?.phase === 'error' && state.url === undefined && !sshRoute && (
                            <View style={styles.explainer}>
                                <Text style={styles.explainerText}>The pairing string is single-use and expires after a few minutes.</Text>
                                <Text style={styles.explainerText}>Run `muxr pair` again for a fresh string, then retry.</Text>
                                {!browser && sshTunnelAvailable() && (
                                    <ActionButton variant="secondary" title="Connect over SSH instead" icon="terminal-outline" onPress={() => router.push('/pair?route=ssh')} />
                                )}
                            </View>
                        )}
                        <Text style={styles.inputLabel}>{browser ? 'Paste browser pairing string' : openedFromSettings ? 'Or paste the pairing string' : sshRoute ? 'Pairing string from `muxr pair`' : 'Enter pairing string manually'}</Text>
                        <TextInput
                            accessibilityLabel="Pairing string"
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            placeholder={browser ? 'https://your-relay/pair#byokit-link:1:…' : 'byokit-link:1:…'}
                            placeholderTextColor={styles.inputPlaceholder.color}
                            returnKeyType="go"
                            style={styles.input}
                            value={pairingValue}
                            onChangeText={setPairingValue}
                            onSubmitEditing={connectManual}
                        />
                        <Text style={styles.routeHint}>{browser
                            ? 'Shown by `muxr pair --browser` on that computer.'
                            : sshRoute
                                ? 'The string proves the machine consented; the SSH details decide how this phone reaches it.'
                                : 'For a computer you are not standing at — copy the string from its terminal.'}</Text>
                        {!sshRoute && <ActionButton title="Connect" icon="link-outline" disabled={!pairingValue.trim()} onPress={connectManual} />}
                        <ActionButton title="Back" variant="quiet" onPress={cancel} />
                    </>
                )}
            </View>
        </PairScrollView>
        {sshRoute && manualForm && (
            // Anchored below the scroll, outside it: with the keyboard open the
            // window resizes and the Connect CTA stays visible at any field.
            <View style={[styles.ctaBar, { paddingBottom: insets.bottom + 8 }]}>
                {sshError !== undefined && <Text accessibilityRole="alert" style={styles.errorText}>{sshError}</Text>}
                <ActionButton title="Connect" icon="link-outline" disabled={!pairingValue.trim()} onPress={connectManual} />
            </View>
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
    hero: {
        alignItems: 'center',
        paddingHorizontal: 16,
    },
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
        ...Typography.default('semiBold'),
        fontSize: 26,
        lineHeight: 32,
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
    grantBullet: {
        width: 18,
        lineHeight: 20,
        textAlign: 'center',
    },
    grantDot: {
        color: theme.colors.text,
    },
    grantText: {
        ...Typography.default(),
        flex: 1,
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
    explainer: {
        alignSelf: 'stretch',
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 14,
    },
    explainerText: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
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
