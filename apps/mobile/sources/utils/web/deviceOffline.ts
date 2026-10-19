import * as React from 'react';

/**
 * True while this browser reports no network at all. Native has no
 * `navigator.onLine`, so it reads as online there and its connecting states
 * are unchanged.
 */
export function useDeviceOffline(): boolean {
    const [offline, setOffline] = React.useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        const sync = () => setOffline(navigator.onLine === false);
        window.addEventListener('online', sync);
        window.addEventListener('offline', sync);
        sync();
        return () => {
            window.removeEventListener('online', sync);
            window.removeEventListener('offline', sync);
        };
    }, []);
    return offline;
}
