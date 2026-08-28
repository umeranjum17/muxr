import { ActionButton } from "@/components/ActionButton";
import { useAuth } from "@/auth/AuthContext";
import { Text, View, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/authGetToken";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { getRandomBytesAsync } from "expo-crypto";
import { useIsLandscape } from "@/utils/responsive";
import { Typography } from "@/constants/Typography";
import { HomeHeaderNotAuth } from "@/herd/ui";
import { MainView } from "@/herd/ui";
import { Wordmark } from "@/components/Wordmark";
import { t } from '@/text';
import { Modal } from '@/modal';
import { resumePendingHostedPairing } from '@/state/hostedE2ee';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/state/connectionSettings';
import { useHostedPairing, usePairQrScanner } from '@/pairing';

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    return <MainView />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();
    const hosted = getCachedConnectionSettings().mode === 'hosted';
    const pairing = React.useRef(false);

    React.useEffect(() => {
        if (!hosted) return;
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
                selfhost: grant.source === 'selfhost' ? true : undefined,
            });
            await auth.login(grant.credential, grant.deviceKey.secretKey);
        }).catch((error) => {
            Modal.alert('Pairing paused', error instanceof Error ? error.message : String(error));
        }).finally(() => { pairing.current = false; });
    }, [auth, hosted]);

    const processPairLink = useHostedPairing();
    const scanHostedQr = usePairQrScanner((url) => void processPairLink(url), hosted);

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

    const promptForPairingString = async (title: string) => {
        const pasted = await Modal.prompt(
            title,
            Platform.OS === 'web'
                ? 'Paste the short link shown by `muxr pair --browser` for eight hours of control, or `muxr pair --browser-view` for view-only access.'
                : 'Paste the pairing string shown by `muxr pair` on that machine. It pairs this phone end-to-end encrypted.',
            { placeholder: Platform.OS === 'web' ? 'https://your-relay/pair?pair=…' : 'wss://your-relay?pair=7KDM4-QXP7N' },
        );
        if (!pasted?.trim()) return;
        await processPairLink(pasted.trim());
    };
    if (hosted) {
        return (
            <View style={styles.screen}>
                <View style={styles.hero}>
                    {heroMark}
                    <Text style={styles.title}>{Platform.OS === 'web' ? 'Run your agents from this browser.' : 'Run your agents from your phone.'}</Text>
                    <Text style={styles.subtitle}>Pair once. Every agent session on your computer, end-to-end encrypted.</Text>
                </View>
                <View style={[styles.actions, { paddingBottom: insets.bottom + 24 }]}>
                    {Platform.OS === 'web' ? (
                        <ActionButton title="Enter pairing string" icon="keypad-outline" action={() => promptForPairingString('Enter pairing string')} />
                    ) : (
                        <>
                            <ActionButton title="Scan QR to pair" icon="qr-code-outline" action={scanHostedQr} />
                            <ActionButton variant="secondary" title="Enter pairing string" icon="keypad-outline" onPress={() => router.push('/pair')} />
                        </>
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