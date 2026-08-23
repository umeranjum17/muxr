import * as React from 'react';
import * as Linking from 'expo-linking';
import { ActivityIndicator, Platform, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/AuthContext';
import { claimHostedPairing, hostedPairingAuthority, hostedPairingDisplayName, prepareHostedPairingInput } from '@/state/hostedE2ee';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/state/connectionSettings';
import { ActionButton } from '@/components/ActionButton';
import { Typography } from '@/constants/Typography';
import { usePairQrScanner } from '@/hooks/usePairing';

/**
 * What pairing actually authorises. The previous copy described only the
 * cryptography, which understated it: this is full interactive control of the
 * machine's agent sessions under the account that started muxr.
 */
const PHONE_PAIRING_GRANTS = [
    'Read every agent terminal on that computer, including whatever is already on screen.',
    'Type into those terminals and answer approval prompts.',
    'Start, stop and restart agents — running as the user who launched muxr.',
] as const;

const BROWSER_CONTROL_GRANTS = [
    'Read and type into every agent terminal on that computer.',
    'Answer approvals and start or stop agents as the user running muxr.',
    'Keep machine keys end-to-end encrypted in this browser for eight hours.',
] as const;

const BROWSER_OBSERVE_GRANTS = [
    'Read agent status and terminal output from this browser.',
    'Keep the machine keys end-to-end encrypted in this browser.',
    'Use this view-only grant for eight hours, then pair again.',
] as const;

const PAIRING_STEPS = [
    'This phone claims the one-time code from the QR or pairing string.',
    'Your machine seals its key grant to this phone only.',
    'The grant is verified against the machine key in the QR.',
] as const;

type PairState =
    | { phase: 'confirm'; url: string; machineName: string }
    | { phase: 'working'; url: string; machineName: string }
    | { phase: 'error'; message: string; url?: string; machineName?: string };

export default function PairScreen() {
    const auth = useAuth();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const [state, setState] = React.useState<PairState | undefined>(undefined);
    const [pairingValue, setPairingValue] = React.useState('');
    // Deep links arrive as route params (expo-router drops unknown query keys
    // from getInitialURL, so the raw URL is only a fallback).
    const routeParams = useLocalSearchParams();
    const browser = Platform.OS === 'web';
    const openedFromSettings = routeParams.source === 'settings';
    const reviewPairing = React.useCallback((raw: string) => {
        try {
            const url = prepareHostedPairingInput(raw);
            setState({ phase: 'confirm', url, machineName: hostedPairingDisplayName(url) });
        } catch (cause) {
            setState({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) });
        }
    }, []);
    const scanPairQr = usePairQrScanner(reviewPairing, !browser && openedFromSettings);
    const browserAuthority = browser && state?.url ? hostedPairingAuthority(state.url) : 'observe';
    const grants = browser
        ? browserAuthority === 'control' ? BROWSER_CONTROL_GRANTS : BROWSER_OBSERVE_GRANTS
        : PHONE_PAIRING_GRANTS;
    const pairingSteps = browser
        ? ['This browser claims the one-time code from the link.', ...PAIRING_STEPS.slice(1)]
        : PAIRING_STEPS;
    const switching = getCachedConnectionSettings().machineId !== '';
    const routePairUrl = React.useMemo(() => {
        const v = routeParams.v;
        if (typeof v !== 'string' || v === '') return undefined;
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(routeParams)) {
            if (key === 'source' || typeof value !== 'string') continue;
            // Expo's deep-link parser form-decodes, so the `%2B` in a
            // standard-base64 machinePk arrives as a space and the rebuilt
            // mailbox no longer matches the machine's signing key. base64
            // has no spaces, so restoring `+` is unambiguous -- but only
            // for that key: the human-readable name may contain real spaces.
            query.set(key, key === 'machinePk' ? value.replace(/ /g, '+') : value);
        }
        return `muxr://pair?${query.toString()}`;
    }, [JSON.stringify(routeParams)]);

    React.useEffect(() => {
        let cancelled = false;
        const receive = (raw: string | null) => {
            if (cancelled || !raw) return false;
            try {
                const url = prepareHostedPairingInput(raw);
                setState((current) => current?.url === url
                    ? current
                    : { phase: 'confirm', url, machineName: hostedPairingDisplayName(url) });
                return true;
            } catch {
                return false;
            }
        };
        if (routePairUrl !== undefined) {
            receive(routePairUrl);
            return undefined;
        }
        void Linking.getInitialURL().then((url) => {
            if (cancelled) return;
            if (!receive(url)) {
                setState({ phase: 'error', message: browser
                    ? 'Paste a fresh browser pairing string from `muxr pair --browser`.'
                    : 'Enter the short pairing string shown by `muxr pair`.' });
            };
        }).catch((cause) => {
            if (!cancelled) setState({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) });
        });
        // Warm start: the app was already open when the link arrived.
        const subscription = Linking.addEventListener('url', (event) => receive(event.url));
        return () => { cancelled = true; subscription.remove(); };
    }, [routePairUrl, browser]);

    const pair = React.useCallback(async (url: string) => {
        const grant = await claimHostedPairing(url);
        await saveConnectionSettings({
            ...getCachedConnectionSettings(),
            mode: 'hosted',
            relayUrl: grant.relayUrl,
            machineId: grant.machineId,
            token: '',
            selfhost: grant.source === 'selfhost' ? true : undefined,
        });
        await auth.login(grant.credential, grant.deviceKey.secretKey);
        router.replace('/');
    }, [auth, router]);

    const confirm = React.useCallback(() => {
        if (state === undefined || (state.phase !== 'confirm' && state.phase !== 'error') || state.url === undefined) return;
        const { url, machineName } = state;
        setState({ phase: 'working', url, machineName: machineName ?? 'this machine' });
        void pair(url).catch((cause) => {
            setState({
                phase: 'error',
                message: cause instanceof Error ? cause.message : String(cause),
                url,
                machineName,
            });
        });
    }, [state, pair]);

    const connectManual = React.useCallback(() => reviewPairing(pairingValue), [pairingValue, reviewPairing]);

    const cancel = React.useCallback(() => {
        if (openedFromSettings) router.back();
        else router.replace('/');
    }, [openedFromSettings, router]);

    return (
        <View style={[styles.screen, { paddingBottom: insets.bottom + 24 }]}>
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
                        {pairingSteps.map((step, index) => (
                            <View key={step} style={styles.stepRow}>
                                <Text style={styles.stepIndex}>{index + 1}</Text>
                                <Text style={styles.stepText}>{step}</Text>
                            </View>
                        ))}
                    </>
                ) : state?.phase === 'confirm' ? (
                    <>
                        <View style={styles.stepGroup}>
                            <Text style={styles.stepHeading}>{browser ? `This ${browserAuthority === 'control' ? 'control' : 'view-only'} browser will be able to` : 'This phone will be able to'}</Text>
                            {grants.map((grant) => (
                                <View key={grant} style={styles.stepRow}>
                                    <Ionicons name="ellipse" size={6} color={styles.grantDot.color} style={styles.grantBullet} />
                                    <Text style={styles.grantText}>{grant}</Text>
                                </View>
                            ))}
                        </View>
                        <View style={styles.securityRow}>
                            <Ionicons name="lock-closed-outline" size={16} color={styles.securityText.color} />
                            <Text style={styles.securityText}>
                                Only continue if you just ran `muxr setup` or `muxr pair` on that computer.
                            </Text>
                        </View>
                        {switching && (
                            <View style={styles.securityRow}>
                                <Ionicons name="swap-horizontal-outline" size={16} color={styles.securityText.color} />
                                <Text style={styles.securityText}>
                                    This device is already paired — pairing switches the active machine to this one. The previous pairing stays saved in Settings.
                                </Text>
                            </View>
                        )}
                        <View style={styles.stepGroup}>
                            <Text style={styles.stepHeading}>How it is secured</Text>
                            {pairingSteps.map((step, index) => (
                                <View key={step} style={styles.stepRow}>
                                    <Text style={styles.stepIndex}>{index + 1}</Text>
                                    <Text style={styles.stepText}>{step}</Text>
                                </View>
                            ))}
                        </View>
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
                        {!browser && openedFromSettings && (
                            <ActionButton title="Scan pairing QR" icon="qr-code-outline" onPress={() => void scanPairQr()} />
                        )}
                        <Text style={styles.inputLabel}>{browser ? 'Paste browser pairing string' : openedFromSettings ? 'Or paste the pairing string' : 'Enter pairing string manually'}</Text>
                        <TextInput
                            accessibilityLabel="Pairing string"
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            placeholder={browser ? 'https://your-relay/pair?pair=7KDM4-QXP7N' : 'wss://your-relay?pair=7KDM4-QXP7N'}
                            placeholderTextColor={styles.inputPlaceholder.color}
                            returnKeyType="go"
                            style={styles.input}
                            value={pairingValue}
                            onChangeText={setPairingValue}
                            onSubmitEditing={connectManual}
                        />
                        <ActionButton title="Connect" icon="link-outline" disabled={!pairingValue.trim()} onPress={connectManual} />
                        <ActionButton title="Back" variant="quiet" onPress={cancel} />
                    </>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
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
        fontSize: 15,
    },
    inputPlaceholder: {
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
