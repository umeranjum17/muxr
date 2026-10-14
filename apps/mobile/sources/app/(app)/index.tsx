import { useAuth } from '@/account/ui';
import { ScrollView, Text, View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { MainView, FirstRunConnection } from '@/herd/ui';
import { HomeWebInstallInvite } from '@/herd/presentation/HomeFirstRunCards';
import { LiveCardEmptyBadge } from '@/plans/ui';
import { Header } from '@/components/navigation/Header';
import { SystemBarBackdrop } from '@/components/SystemBarBackdrop';
import { useCompactWindow } from '@/components/useCompactWindow';
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
    const compact = useCompactWindow();
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
            <Header title={<Text style={styles.headerTitle}>Connect a machine</Text>} headerShadowVisible={false} />
            <ScrollView
                style={styles.screen}
                contentContainerStyle={[styles.content, { paddingBottom: 24, paddingHorizontal: compact ? 8 : 16 }]}
                keyboardShouldPersistTaps="handled"
            >
                <FirstRunConnection />
                <HomeWebInstallInvite variant="firstRun" />
            </ScrollView>
            <SystemBarBackdrop edge="bottom" />
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
