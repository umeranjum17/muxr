import * as React from 'react';

/**
 * True while this browser reports no network at all. Native has no
 * `navigator.onLine`, so it reads as online there and its connecting states
 * are unchanged.
 */
function isDeviceOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Retry feedback that never blames the computer while this device has no network. */
export function unavailableFeedback(): string {
    return isDeviceOffline()
        ? 'This device is offline. Check the connection, then tap Retry once you are back online.'
        : 'Still unavailable. Run the command on your computer, check its network, then retry.';
}

export function useDeviceOffline(): boolean {
    const [offline, setOffline] = React.useState(isDeviceOffline);
    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        const sync = () => setOffline(isDeviceOffline());
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
