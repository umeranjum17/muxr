import * as React from 'react';
import { getCachedConnectionSettings } from '@/connection/connectionSettings';

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_INTERVAL_MS = 5_000;

/**
 * Whether this device can reach the paired computer's relay within a short
 * timeout. `navigator.onLine` stays true while a VPN holds the network up with
 * no route out, so the verdict is the fetch, not the flag.
 */
export async function relayAnswers(relayUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const health = new URL(relayUrl);
        health.protocol = health.protocol === 'wss:' ? 'https:' : 'http:';
        health.pathname = '/health';
        health.search = '';
        // `no-cors` lets a cross-origin web app see reachability without the relay's CORS headers.
        await fetch(health.toString(), { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** True when this device has no route to the paired computer. An unpaired device has nothing to reach, so it is never offline here. */
export async function isDeviceOffline(): Promise<boolean> {
    const settings = getCachedConnectionSettings();
    if (settings.machineId === '') return false;
    return !(await relayAnswers(settings.relayUrl));
}

/** Retry feedback that never blames the computer while this device has no network. */
export async function unavailableFeedback(): Promise<string> {
    return (await isDeviceOffline())
        ? 'This device is offline. Check the connection, then tap Retry once you are back online.'
        : 'Still unavailable. Run the command on your computer, check its network, then retry.';
}

export function useDeviceOffline(): boolean {
    const [offline, setOffline] = React.useState(false);
    React.useEffect(() => {
        let active = true;
        const check = () => void isDeviceOffline().then((next) => { if (active) setOffline(next); });
        check();
        const timer = setInterval(check, PROBE_INTERVAL_MS);
        // Browser online/offline events only make the next check immediate; they never set the verdict.
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('online', check);
            window.addEventListener('offline', check);
        }
        return () => {
            active = false;
            clearInterval(timer);
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('online', check);
                window.removeEventListener('offline', check);
            }
        };
    }, []);
    return offline;
}
