import * as React from 'react';
import { ScopedTheme, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';

/**
 * The dark theme for a surface that always paints dark, such as the terminal
 * and the sheets over it.
 *
 * A scoped theme is not free: every render beneath it re-applies the scoped
 * styles natively and commits the shadow tree. When the app already runs the
 * dark theme the scope would change nothing, so it is left out.
 */
export function DarkScope({ children }: { children: React.ReactNode }): React.JSX.Element {
    // Read for the subscription: it re-renders this scope when the theme
    // changes. Its value follows an enclosing scope, so the decision reads
    // the app's own theme instead.
    useUnistyles().rt.themeName;
    return UnistylesRuntime.themeName === 'dark' ? <>{children}</> : <ScopedTheme name="dark">{children}</ScopedTheme>;
}
