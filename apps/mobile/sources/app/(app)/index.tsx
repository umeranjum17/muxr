import { useAuth } from '@/account/ui';
import { ScrollView, Text, View, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { MainView, FirstRunConnection } from '@/herd/ui';
import { Wordmark } from '@/components/Wordmark';
import { Modal } from '@/modal';
import { resumePendingHostedPairing } from '@/pairing/e2ee';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/connection';

export default function Home() {
    const auth = useAuth();
    if (auth.isAuthenticated) return <MainView />;
    return <NotAuthenticated />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const insets = useSafeAreaInsets();
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
                selfhost: grant.source === 'selfhost' ? true : undefined,
            });
            await auth.login(grant.credential, grant.deviceKey.secretKey);
        }).catch((error) => {
            Modal.alert('Pairing paused', error instanceof Error ? error.message : String(error));
        }).finally(() => { pairing.current = false; });
    }, [auth]);

    return (
        <ScrollView
            style={styles.screen}
            contentContainerStyle={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.hero}>
                <View style={styles.markHalo} accessibilityLabel="muxr">
                    <View style={styles.markInner}><Wordmark width={148} /></View>
                </View>
                <Text style={styles.title}>{Platform.OS === 'web' ? 'Run your agents from this browser.' : 'Run your agents from your phone.'}</Text>
                <Text style={styles.subtitle}>Pair once. Every agent session on your computer, end-to-end encrypted.</Text>
            </View>
            <FirstRunConnection />
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1 },
    content: {
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 24,
        paddingHorizontal: 16,
    },
    hero: { alignItems: 'center', paddingHorizontal: 16 },
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
