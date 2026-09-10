import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { MainView } from '@/herd/ui';
import { DemoBar } from '@/demo/DemoBar';
import { activateDemoTransport, ensureDemoRuntime } from '@/demo/demoRuntime';

export const unstable_settings = {
    headerShown: false,
};

/**
 * Public acquisition route: the production app shell (herd, inbox,
 * terminals, files, diffs) driven by the deterministic demo backend — no
 * backend, no pairing, no network beyond static assets. Web-only and
 * unpaired-only: native or paired contexts redirect home, and the demo
 * backend never ships in the native graph.
 */
export default function DemoRoute() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [allowed, setAllowed] = React.useState(false);
    React.useEffect(() => {
        let live = true;
        void ensureDemoRuntime().then((ok) => {
            if (!live) return;
            if (!ok) router.replace('/');
            else {
                // Sticky for this page load: session routes leave /demo but
                // stay inside the replay. Only this gated route sets it.
                activateDemoTransport();
                setAllowed(true);
            }
        });
        return () => {
            live = false;
        };
    }, [router]);
    if (!allowed) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}>
                <ActivityIndicator color={theme.colors.textSecondary} />
            </View>
        );
    }
    return (
        <View style={{ flex: 1 }}>
            <Stack.Screen options={{ headerShown: false, headerTitle: 'Demo replay' }} />
            <DemoBar />
            <MainView />
        </View>
    );
}
