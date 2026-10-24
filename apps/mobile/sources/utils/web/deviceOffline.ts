import * as React from 'react';
import { Platform } from 'react-native';
import { getCachedConnectionSettings } from '@/connection/connectionSettings';
import { isTailscaleAddress } from '@/pairing/domain/pairingString';

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_INTERVAL_MS = 5_000;

/**
 * Public endpoints that answer any device with internet. They separate "this
 * device has no network" from "the paired computer does not answer": a phone
 * on Wi-Fi with Tailscale off fails the relay probe but passes these.
 */
const INTERNET_PROBE_URLS = ['https://connectivitycheck.gstatic.com/generate_204', 'https://cloudflare.com/cdn-cgi/trace'];

async function answers(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        // `no-cors` lets a cross-origin web app see reachability without the far end's CORS headers.
        await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

function relayHealthUrl(relayUrl: string): string {
    const health = new URL(relayUrl);
    health.protocol = health.protocol === 'wss:' ? 'https:' : 'http:';
    health.pathname = '/health';
    health.search = '';
    return health.toString();
}

/**
 * What stands between this device and the paired computer. `navigator.onLine`
 * stays true while a VPN holds the network up with no route out, so the relay
 * half is a fetch, not the flag; `internet` is the other half.
 * - `reachable`: the relay answers.
 * - `unreachable`: the internet answers but the relay does not.
 * - `offline`: neither answers.
 */
export async function reachVerdict(relayUrl: string, internet: () => Promise<boolean> = internetAnswers): Promise<'reachable' | 'unreachable' | 'offline'> {
    if (await answers(relayHealthUrl(relayUrl))) return 'reachable';
    return await internet() ? 'unreachable' : 'offline';
}

/** Whether any of `urls` answers: the internet half of the verdict. */
export async function internetAnswers(urls: readonly string[] = INTERNET_PROBE_URLS): Promise<boolean> {
    return (await Promise.all(urls.map(answers))).includes(true);
}

export type DeviceReach = 'reachable' | 'offline' | 'tailscale-off' | 'unreachable';

/** The verdict for the paired computer, with `tailscale-off` when its relay is
 *  a Tailscale address and this device is online without one. An unpaired
 *  device has nothing to reach, so it is always `reachable` here. */
export async function deviceReach(): Promise<DeviceReach> {
    const settings = getCachedConnectionSettings();
    if (settings.machineId === '') return 'reachable';
    // The web build's CSP admits no public https origin, so there the
    // browser's own flag is the internet half: it can miss a VPN with no
    // route out, but it never blames a network that is up.
    const verdict = await reachVerdict(settings.relayUrl, Platform.OS === 'web' ? async () => navigator.onLine !== false : internetAnswers);
    if (verdict !== 'unreachable' || !isTailscaleAddress(settings.relayUrl)) return verdict;
    // Loaded on use, so the web build needs no native bridge.
    return (await import('@/../modules/tailnet-address')).hasTailnetAddress() === false ? 'tailscale-off' : verdict;
}

/** Retry feedback that never blames the computer while this device has no network, nor the network while it has one. */
export async function unavailableFeedback(): Promise<string> {
    const reach = await deviceReach();
    if (reach === 'offline') return 'This device is offline. Check the connection, then tap Retry once you are back online.';
    if (reach === 'tailscale-off') return 'Tailscale is off on this device. Turn it on, then tap Retry.';
    return 'Still unavailable. Run the command on your computer, check its network, then retry.';
}

export function useDeviceReach(): DeviceReach {
    const [reach, setReach] = React.useState<DeviceReach>('reachable');
    React.useEffect(() => {
        let active = true;
        const check = () => void deviceReach().then((next) => { if (active) setReach(next); });
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
    return reach;
}
