import { useAuth } from '@/account/ui';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { MainView, FirstRunConnection } from '@/herd/ui';
import { HomeWebInstallInvite } from '@/herd/presentation/HomeFirstRunCards';
import { LiveCardEmptyBadge } from '@/plans/ui';
import { Header } from '@/components/navigation/Header';
import { Modal } from '@/modal';
import { resumePendingHostedPairing } from '@/pairing/e2ee';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/connection';

export default function Home() {
    const auth = useAuth();
    if (auth.isAuthenticated) return <MainView liveCardBadge={LiveCardEmptyBadge} />;
    return <NotAuthenticated />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const insets = useSafeAreaInsets();
    const { width, fontScale } = useWindowDimensions();
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
        <View style={styles.screen}>
            <Header title={<Text style={styles.headerTitle}>Connect a machine</Text>} />
            <ScrollView
                style={styles.screen}
                contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24, paddingHorizontal: width / fontScale < 200 ? 8 : 16 }]}
                keyboardShouldPersistTaps="handled"
            >
                <FirstRunConnection />
                <HomeWebInstallInvite variant="firstRun" />
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1 },
    content: {
        flexGrow: 1,
        alignItems: 'center',
        gap: 20,
        paddingTop: 22,
    },
    headerTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text,
    },
}));
