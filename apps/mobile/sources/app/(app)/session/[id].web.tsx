import * as React from 'react';
import { View } from 'react-native';
import { useRoute } from "@react-navigation/native";
import { useUnistyles } from 'react-native-unistyles';

// The live terminal screen is a lazy route: the landing and pair screens never
// draw one, so its chunk (and the xterm payload inside it) loads only when an
// agent is opened.
const TerminalRoute = React.lazy(async () => ({ default: (await import('@/terminal/presentation/TerminalRoute')).TerminalRoute }));

export default React.memo(() => {
    const { theme } = useUnistyles();
    const route = useRoute();
    const { id, desktop } = route.params as { id: string; desktop?: string };
    return (
        <React.Suspense fallback={<View style={{ flex: 1, backgroundColor: theme.colors.terminal.background }} />}>
            <TerminalRoute id={id} desktop={desktop === '1'} preview={desktop === 'preview'} />
        </React.Suspense>
    );
});
