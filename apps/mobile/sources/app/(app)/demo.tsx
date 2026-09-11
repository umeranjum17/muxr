import * as React from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { MainView } from '@/herd/ui';
import { activateDemoTransport, ensureDemoRuntime } from '@/demo/demoRuntime';
import { DEMO_MACHINE_ID } from '@/demo/demoRecords';
import { useNewSessionDraft } from '@/spawn';
import { storage } from '@/catalog/store';
import { onDemoTransitionComplete } from '@/demo/demoTransport';
import { sync } from '@/catalog/sync';
import { LoadingHairline } from '@/components/LoadingHairline';

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
    // Tree-pane state (live cards, Spaces rows) only re-reads on explicit
    // tree refreshes — event transitions don't touch it, and a focusless
    // context never runs the interval/focus refreshes. Re-read once when a
    // scripted transition completes, through the same production refresh.
    React.useEffect(() => {
        if (!allowed) return undefined;
        return onDemoTransitionComplete(() => {
            void sync.refreshHerdTree().catch(() => undefined);
        });
    }, [allowed]);
    React.useEffect(() => {
        let live = true;
        void ensureDemoRuntime().then(async (ok) => {
            if (!live) return;
            if (!ok) {
                router.replace('/');
                return;
            }
            // Sticky for this page load: session routes leave /demo but
            // stay inside the replay. Only this gated route sets it.
            activateDemoTransport();
            // Deterministic bootstrap, not focus-dependent: drive the first
            // production herd/catalog refresh through the activated demo
            // transport BEFORE MainView mounts, so the herd never depends on
            // a focus effect firing to perform its first load. The catalog
            // refresh also loads machines, which the dock spawn flow needs.
            // Default the in-memory draft to the demo machine: the unpaired
            // demo has no connection machine to sync from, and this writes
            // nothing persisted (unlike setMachineId, which would).
            try {
                await sync.refreshHerdTree();
                await sync.refreshSessions();
                // The catalog refresh loaded machines through the real path;
                // mark it ready so selectors (machines, sessions) read what
                // the demo transport served. No credentials involved.
                storage.getState().applyReady();
                useNewSessionDraft.setState({
                    selectedMachineId: DEMO_MACHINE_ID,
                    selectedPath: null,
                    worktreeKey: null,
                });
            } catch {
                // MainView's own refresh covers a bootstrap miss.
            }
            if (!live) return;
            setAllowed(true);
        });
        return () => {
            live = false;
        };
    }, [router]);
    // The shell paints at once: the demo bar is the frame, and the herd
    // below carries its own hairline until the fixture has bootstrapped.
    return (
        <View style={{ flex: 1 }}>
            <Stack.Screen options={{ headerShown: false, headerTitle: 'Demo replay' }} />
            {allowed ? <MainView /> : <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}><LoadingHairline active /></View>}
        </View>
    );
}
