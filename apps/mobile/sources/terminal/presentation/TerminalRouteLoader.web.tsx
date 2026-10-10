import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { TerminalRoute as TerminalRouteComponent } from './TerminalRoute';

const LazyTerminalRoute = React.lazy(async () => ({ default: (await import('./TerminalRoute')).TerminalRoute }));

export function TerminalRoute(props: React.ComponentProps<typeof TerminalRouteComponent>): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <React.Suspense fallback={<View style={{ flex: 1, backgroundColor: theme.colors.terminal.background }} />}>
            <LazyTerminalRoute {...props} />
        </React.Suspense>
    );
}
