import { ActionButton } from "@/components/ActionButton";
import { useAuth } from "@/auth/AuthContext";
import { Text, View, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/authGetToken";
import { router, useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { getRandomBytesAsync } from "expo-crypto";
import { useIsLandscape } from "@/utils/responsive";
import { useRelayDiscovery, type DiscoveredRelay } from "@/discovery/useRelayDiscovery";
import { Typography } from "@/constants/Typography";
import { HomeHeaderNotAuth } from "@/components/HomeHeader";
import { MainView } from "@/components/MainView";
import { Wordmark } from "@/components/Wordmark";
import { t } from '@/text';
import { CameraView } from 'expo-camera';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { Modal } from '@/modal';
import { claimHostedPairing, hostedPairingDisplayName, resumePendingHostedPairing } from '@/state/hostedE2ee';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/state/connectionSettings';
import { MOBILE_ONBOARDING_CHOICES } from '@/commercialization';

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    return <MainView variant="phone" />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();
    const hosted = getCachedConnectionSettings().mode === 'hosted';
    const checkScannerPermissions = useCheckScannerPermissions();
    const pairing = React.useRef(false);

    React.useEffect(() => {
        if (pairing.current) return;
        pairing.current = true;
        void resumePendingHostedPairing().then(async (grant) => {
            if (grant === undefined) return;
            await saveConnectionSettings({
                ...getCachedConnectionSettings(),
                mode: 'hosted',
                relayUrl: grant.relayUrl,
                machineId: grant.machineId,
                token: '',
                encryptionKey: '',
                selfhost: grant.source === 'selfhost' ? true : undefined,
            });
            await auth.login(grant.credential, grant.deviceKey.secretKey);
        }).catch((error) => {
            Modal.alert('Pairing paused', error instanceof Error ? error.message : String(error));
        }).finally(() => { pairing.current = false; });
    }, [auth]);

    const processPairLink = React.useCallback(async (url: string) => {
        if (pairing.current) return;
        pairing.current = true;
        try {
            const approved = await Modal.confirm(
                `Pair with ${hostedPairingDisplayName(url)}?`,
                'This phone will be able to read and type into every agent terminal on that computer, answer approvals, and start or stop agents as the user who launched muxr.\n\nOnly continue if you just ran `muxr setup` or `muxr pair` there.',
                { confirmText: 'Pair' },
            );
            if (!approved) return;
            const grant = await claimHostedPairing(url);
            await saveConnectionSettings({
                ...getCachedConnectionSettings(),
                mode: 'hosted',
                relayUrl: grant.relayUrl,
                machineId: grant.machineId,
                token: '',
                encryptionKey: '',
                selfhost: grant.source === 'selfhost' ? true : undefined,
            });
            await auth.login(grant.credential, grant.deviceKey.secretKey);
        } catch (error) {
            Modal.alert('Pairing failed', error instanceof Error ? error.message : String(error));
        } finally {
            pairing.current = false;
        }
    }, [auth]);

    React.useEffect(() => {
        if (!hosted || !CameraView.isModernBarcodeScannerAvailable) return;
        const subscription = CameraView.onModernBarcodeScanned((event) => {
            if (/^https:\/\/[^#]+\/pair#/.test(event.data) || /^muxr:\/\/pair[?#]/.test(event.data) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/pair#/.test(event.data)) {
                void CameraView.dismissScanner().catch(() => undefined);
                void processPairLink(event.data);
            }
        });
        return () => subscription.remove();
    }, [hosted, processPairLink]);

    const scanHostedQr = async () => {
        // Prime before the system prompt: a bare permission dialog with no
        // context reads as suspicious on a security product.
        const primed = await Modal.confirm(
            'Scan your machine QR',
            'Point the camera at the QR code shown by `muxr setup` or `muxr pair` on your computer. The scan completes an end-to-end encrypted pairing — the image never leaves this phone.',
            { confirmText: 'Open camera' },
        );
        if (!primed) return;
        if (!(await checkScannerPermissions())) {
            Modal.alert('Camera required', 'Allow camera access to scan the secure machine QR.');
            return;
        }
        CameraView.launchScanner({ barcodeTypes: ['qr'] });
    };

    // One mark, in a soft halo. The hero previously stacked glyph.png (upscaled
    // from a small source, hence the blur) above the wordmark saying the same
    // thing. Wordmark is downscaled from 300x36 here, so it stays sharp; a true
    // vector needs either react-native-svg or a 3x re-render via genBrand.sh.
    const heroMark = (
        <View style={styles.markHalo} accessibilityLabel="muxr">
            <View style={styles.markInner}>
                <Wordmark width={148} />
            </View>
        </View>
    );

    const discoveredRelays = useRelayDiscovery();
    const [showOtherWays, setShowOtherWays] = React.useState(false);
    const promptForPairingString = async (title: string) => {
        const pasted = await Modal.prompt(
            title,
            'Paste the pairing string shown by `muxr self-host` on that machine. It pairs this phone end-to-end encrypted.',
            { placeholder: 'muxr://pair#…' },
        );
        if (!pasted?.trim()) return;
        await processPairLink(pasted.trim());
    };
    // Discovery only ever proposes a machine; the user still confirms. Finding a
    // relay must never mean joining it.
    const pairWithDiscovered = (relay: DiscoveredRelay) => promptForPairingString(`Pair with ${relay.name}?`);

    if (hosted) {
        return (
            <View style={styles.screen}>
                <View style={styles.hero}>
                    {heroMark}
                    <Text style={styles.title}>Run your agents from your phone.</Text>
                    <Text style={styles.subtitle}>Pair once. Every agent session on your computer, end-to-end encrypted.</Text>
                </View>
                <View style={[styles.actions, { paddingBottom: insets.bottom + 24 }]}>
                    {discoveredRelays.map((relay) => (
                        <View key={`${relay.name}-${relay.host}`} style={styles.foundCard}>
                            <View style={styles.foundHeader}>
                                <View style={styles.foundIcon}>
                                    <Ionicons name="desktop-outline" size={18} color={styles.foundIconGlyph.color} />
                                </View>
                                <View style={styles.foundCopy}>
                                    <Text style={styles.foundTitle} numberOfLines={1}>Found muxr on {relay.name}</Text>
                                    <Text style={styles.foundMeta} numberOfLines={1}>On this network · not connected yet</Text>
                                </View>
                            </View>
                            <ActionButton title="Connect" icon="link-outline" action={() => pairWithDiscovered(relay)} />
                        </View>
                    ))}
                    <ActionButton title={MOBILE_ONBOARDING_CHOICES[0]} icon="qr-code-outline" action={scanHostedQr} />
                    {showOtherWays ? (
                        <View style={styles.otherWays}>
                            <ActionButton variant="secondary" title="Paste a pairing string" icon="clipboard-outline" action={() => promptForPairingString('Paste pairing string')} />
                            <ActionButton variant="quiet" title="Advanced setup" icon="terminal-outline" onPress={() => router.push('/settings/ssh')} />
                        </View>
                    ) : (
                        <ActionButton
                            variant="quiet"
                            title="Other ways to connect"
                            icon="chevron-down"
                            onPress={() => setShowOtherWays(true)}
                        />
                    )}
                    <Text style={styles.footer}>End-to-end encrypted · machine keys never leave your devices</Text>
                </View>
            </View>
        );
    }

    const createAccount = async () => {
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
            }
        } catch (error) {
            console.error('Error creating account', error);
        }
    }

    const accountActions = Platform.OS !== 'android' && Platform.OS !== 'ios' ? (
        <>
            <ActionButton
                title={t('welcome.loginWithMobileApp')}
                onPress={() => {
                    router.push('/restore');
                }}
            />
            <ActionButton
                variant="secondary"
                title={t('welcome.createAccount')}
                action={createAccount}
            />
        </>
    ) : (
        <>
            <ActionButton title={t('welcome.createAccount')} action={createAccount} />
            <ActionButton
                variant="secondary"
                title={t('welcome.linkOrRestoreAccount')}
                onPress={() => {
                    router.push('/restore');
                }}
            />
        </>
    );

    const portraitLayout = (
        <View style={styles.screen}>
            <View style={styles.hero}>
                {heroMark}
                <Text style={styles.title}>
                    {t('welcome.title')}
                </Text>
                <Text style={styles.subtitle}>
                    {t('welcome.subtitle')}
                </Text>
            </View>
            <View style={[styles.actions, { paddingBottom: insets.bottom + 24 }]}>
                {accountActions}
            </View>
        </View>
    );

    const landscapeLayout = (
        <View style={[styles.landscapeContainer, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.landscapeInner}>
                <View style={styles.landscapeLogoSection}>
                    {heroMark}
                </View>
                <View style={styles.landscapeContentSection}>
                    <Text style={styles.landscapeTitle}>
                        {t('welcome.title')}
                    </Text>
                    <Text style={styles.landscapeSubtitle}>
                        {t('welcome.subtitle')}
                    </Text>
                    <View style={styles.landscapeActions}>
                        {accountActions}
                    </View>
                </View>
            </View>
        </View>
    );

    return (
        <>
            <HomeHeaderNotAuth />
            {isLandscape ? landscapeLayout : portraitLayout}
        </>
    )
}

const styles = StyleSheet.create((theme) => ({
    // NotAuthenticated styles
    screen: {
        flex: 1,
    },
    hero: {
        flex: 1,
        alignItems: 'center',
        // Weighted low rather than dead-centre: the old layout left a ~400px
        // void between the mark and the buttons.
        justifyContent: 'flex-end',
        paddingBottom: 36,
        paddingHorizontal: 32,
    },
    // Two concentric low-alpha rings stand in for a blur halo -- RN has no CSS
    // blur without a native dependency, and this reads the same at hero size.
    markHalo: {
        padding: 26,
        borderRadius: 999,
        backgroundColor: theme.colors.accentFaint,
        alignItems: 'center',
        justifyContent: 'center',
    },
    markInner: {
        paddingVertical: 18,
        paddingHorizontal: 24,
        borderRadius: 999,
        backgroundColor: theme.colors.accentSubtle,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        marginTop: 32,
        textAlign: 'center',
        fontSize: 23,
        lineHeight: 29,
        letterSpacing: -0.3,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
        marginTop: 10,
        textAlign: 'center',
        maxWidth: 300,
    },
    actions: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: 340,
        paddingHorizontal: 24,
        gap: 10,
    },
    otherWays: {
        gap: 10,
    },
    foundCard: {
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 18,
        padding: 14,
        gap: 12,
        marginBottom: 2,
    },
    foundHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    foundIcon: {
        width: 38,
        height: 38,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    foundIconGlyph: {
        color: theme.colors.text,
    },
    foundCopy: {
        flex: 1,
        gap: 2,
    },
    foundTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text,
    },
    foundMeta: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    footer: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 8,
    },
    // Landscape styles
    landscapeContainer: {
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 48,
    },
    landscapeInner: {
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: 800,
        flexDirection: 'row',
    },
    landscapeLogoSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingRight: 24,
    },
    landscapeContentSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: 24,
    },
    landscapeTitle: {
        textAlign: 'center',
        fontSize: 26,
        lineHeight: 32,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    landscapeSubtitle: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 23,
        color: theme.colors.textSecondary,
        marginTop: 12,
        textAlign: 'center',
        marginBottom: 28,
        paddingHorizontal: 16,
    },
    landscapeActions: {
        width: 300,
        gap: 12,
    },
}));