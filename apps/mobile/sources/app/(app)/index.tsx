import { useAuth } from '@/account/ui';
import { ScrollView, Text, View, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { MainView, FirstRunConnection, TailscaleStep } from '@/herd/ui';
import { HomeWebInstallInvite } from '@/herd/presentation/HomeFirstRunCards';
import { LiveCardEmptyBadge } from '@/plans/ui';
import { Wordmark } from '@/components/Wordmark';
import { SystemBarBackdrop } from '@/components/SystemBarBackdrop';
import { Modal } from '@/modal';
import { resumePendingHostedPairing } from '@/pairing/e2ee';
import { pairingDeviceNoun } from '@/pairing';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/connection';

export default function Home() {
    const auth = useAuth();
    if (auth.isAuthenticated) return <MainView liveCardBadge={LiveCardEmptyBadge} />;
    return <NotAuthenticated />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const insets = useSafeAreaInsets();
    const { width: windowWidth } = useWindowDimensions();
    const pairing = React.useRef(false);
    const [hasTailscale, setHasTailscale] = React.useState(false);

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
                selfhost: grant.source === 'selfhost' ? true : undefined,
            });
            await auth.login(grant.credential, grant.deviceKey.secretKey);
        }).catch((error) => {
            Modal.alert('Pairing paused', error instanceof Error ? error.message : String(error));
        }).finally(() => { pairing.current = false; });
    }, [auth]);

    // The halo, its inner pill and the wordmark measure 248pt across at full
    // size; the hero only has the window minus its own padding. Shrink the
    // whole mark to fit viewports narrower than that instead of bleeding past
    // both screen edges. At 312pt and up the scale is 1: unchanged.
    const markScale = Math.min(1, Math.max(0, (windowWidth - 64) / (148 + 2 * (26 + 24))));

    return (
        <View style={styles.screen}>
            <SystemBarBackdrop edge="top" />
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={[styles.content, { paddingTop: 20, paddingBottom: insets.bottom + 24 }]}
                keyboardShouldPersistTaps="handled"
            >
                <View style={styles.hero}>
                    <View style={[styles.markHalo, { padding: 26 * markScale }]} accessibilityLabel="muxr">
                        <View style={[styles.markInner, { paddingVertical: 18 * markScale, paddingHorizontal: 24 * markScale }]}>
                            <Wordmark width={148 * markScale} />
                        </View>
                    </View>
                <Text style={styles.title}>{Platform.OS === 'web' ? 'Run your agents from this browser.' : `Run your agents from your ${pairingDeviceNoun()}.`}</Text>
                <Text style={styles.subtitle}>Pair once. Every agent session on your computer, end-to-end encrypted.</Text>
            </View>
            {hasTailscale ? <FirstRunConnection /> : <TailscaleStep onReady={() => setHasTailscale(true)} />}
            <HomeWebInstallInvite variant="firstRun" />
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1 },
    scroll: { flex: 1 },
    content: {
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 24,
        paddingHorizontal: 16,
    },
    // Stretch to the row: without it the web sizer can take the title's
    // max-content width and bleed the centered text past a narrow viewport.
    hero: { alignItems: 'center', paddingHorizontal: 16, alignSelf: 'stretch' },
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
}));
