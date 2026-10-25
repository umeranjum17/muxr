import { useAuth } from '@/account/ui';
import { Platform, ScrollView, View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { MainView, FirstRunConnection } from '@/herd/ui';
import { DemoHome } from '@/demo/ui';
import { HomeWebInstallInvite } from '@/herd/presentation/HomeFirstRunCards';
import { LiveCardEmptyBadge } from '@/plans/ui';
import { Header } from '@/components/navigation/Header';
import { SystemBarBackdrop } from '@/components/SystemBarBackdrop';
import { useCompactWindow } from '@/components/useCompactWindow';
import { Modal } from '@/modal';
import { resumePendingHostedPairing } from '@/pairing/e2ee';
import { pairMachine } from '@/pairing';

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
            const activated = await pairMachine({ grant });
            if (!activated.ok) throw new Error(activated.reason === 'failed' ? activated.message : 'Realtime voice is still pinned to another computer.');
            await auth.login(activated.credential, activated.secretKey);
        }).catch((error) => {
            Modal.alert('Pairing paused', error instanceof Error ? error.message : String(error));
        }).finally(() => { pairing.current = false; });
    }, [auth]);

    // A browser with no computer paired gets the sample herd first, so a
    // visitor can see what muxr does before setting anything up; its last
    // step is the same pairing screen everyone else uses.
    if (Platform.OS === 'web') {
        return (
            <View style={styles.screen}>
                <Header title="Demo" headerShadowVisible={false} />
                <DemoHome footer={<HomeWebInstallInvite />} />
                <SystemBarBackdrop edge="bottom" />
            </View>
        );
    }

    return (
        <View style={styles.screen}>
            <Header
                title="Connect a machine"
                headerShadowVisible={false}
            />
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

const styles = StyleSheet.create({
    screen: { flex: 1 },
    content: {
        flexGrow: 1,
        alignItems: 'center',
        gap: 20,
        paddingTop: 22,
    },
});
