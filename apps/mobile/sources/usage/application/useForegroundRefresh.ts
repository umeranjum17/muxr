import * as React from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * Keeps a screen's figures current without ever working for a screen nobody is
 * looking at.
 *
 * Refreshes on the three moments that matter -- taking focus, the app coming
 * back to the foreground, and a slow timer in between -- and runs the timer
 * only while both hold. Losing focus or leaving the foreground stops it, so a
 * backgrounded app and a screen behind another one cost no wakeups, no
 * requests, and no battery at all.
 */
export function useForegroundRefresh(refresh: () => void, intervalMs: number): void {
    const latest = React.useRef(refresh);
    latest.current = refresh;
    useFocusEffect(React.useCallback(() => {
        let timer: ReturnType<typeof setInterval> | undefined;
        const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
        const start = () => { stop(); timer = setInterval(() => latest.current(), intervalMs); };
        latest.current();
        if (AppState.currentState === 'active') start();
        // Coming back from the background is its own moment: the figures aged
        // for the whole time away, so ask once now rather than waiting out the
        // remainder of a timer that was not running.
        const subscription = AppState.addEventListener('change', (next) => {
            if (next !== 'active') { stop(); return; }
            latest.current();
            start();
        });
        return () => { stop(); subscription.remove(); };
    }, [intervalMs]));
}
