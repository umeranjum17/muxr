import * as React from 'react';
import { AppState, Platform } from 'react-native';
import type { BrowseHandle, BrowseService } from '@byokit/reach';
import { useAuth } from '@/account/ui';
import { getCachedConnectionSettings } from '@/connection';
import { reconnectMachine } from './ReconnectMachine';
import { discoveredRelay, type DiscoveredRelay } from './relayLocator';

export type { DiscoveredRelay };

export type RelayDiscoveryPhase = 'disabled' | 'web' | 'scanning' | 'no-service' | 'found'
    | 'verifying' | 'updated' | 'unverified' | 'permission' | 'unavailable' | 'failed';

let discoveryPhase: RelayDiscoveryPhase = Platform.OS === 'web' ? 'web' : 'disabled';
const discoveryListeners = new Set<() => void>();
let retryScan: (() => void) | undefined;

function setDiscoveryPhase(phase: RelayDiscoveryPhase): void {
    if (discoveryPhase === phase) return;
    discoveryPhase = phase;
    discoveryListeners.forEach((listener) => listener());
}

export function useRelayDiscoveryPhase(): RelayDiscoveryPhase {
    return React.useSyncExternalStore(
        (listener) => { discoveryListeners.add(listener); return () => { discoveryListeners.delete(listener); }; },
        () => discoveryPhase,
        () => 'web',
    );
}

export function retryRelayDiscovery(): void { retryScan?.(); }

function scanFailure(cause: unknown): RelayDiscoveryPhase {
    const message = cause instanceof Error ? cause.message : String(cause);
    return /permission|denied|securityexception/i.test(message) ? 'permission' : 'failed';
}

/** LAN locator scan. A result never authorises a machine; the stored E2EE grant does. */
export function useRelayDiscovery(enabled = true): DiscoveredRelay[] {
    const [relays, setRelays] = React.useState<DiscoveredRelay[]>([]);

    React.useEffect(() => {
        if (Platform.OS === 'web') { setDiscoveryPhase('web'); return undefined; }
        if (!enabled) { setDiscoveryPhase('disabled'); return undefined; }
        let browse: typeof import('@byokit/reach').browse;
        try { ({ browse } = require('@byokit/reach')); }
        catch { setDiscoveryPhase('unavailable'); return undefined; }
        let active: BrowseHandle | undefined;
        let noServiceTimer: ReturnType<typeof setTimeout> | undefined;
        let preemptedTimer: ReturnType<typeof setTimeout> | undefined;
        let found = false;
        let activeServiceName: string | undefined;
        const clearNoServiceTimer = () => {
            if (noServiceTimer !== undefined) clearTimeout(noServiceTimer);
            noServiceTimer = undefined;
        };
        const waitForService = () => {
            clearNoServiceTimer();
            noServiceTimer = setTimeout(() => {
                if (!found && discoveryPhase === 'scanning') setDiscoveryPhase('no-service');
            }, 10_000);
        };
        const onResolved = (service: BrowseService) => {
            const relay = discoveredRelay(service);
            if (relay === undefined || relay.machineId !== getCachedConnectionSettings().machineId) return;
            found = true;
            activeServiceName = relay.name;
            clearNoServiceTimer();
            if (discoveryPhase !== 'verifying' && discoveryPhase !== 'updated') setDiscoveryPhase('found');
            setRelays((current) => current[0]?.relayUrl === relay.relayUrl ? current : [relay]);
        };
        const onRemoved = (name: string) => {
            if (name !== activeServiceName) return;
            found = false;
            activeServiceName = undefined;
            setRelays([]);
            setDiscoveryPhase('scanning');
            waitForService();
        };
        const onError = (cause: unknown) => {
            clearNoServiceTimer();
            setDiscoveryPhase(scanFailure(cause));
        };
        const scan = () => {
            if (preemptedTimer !== undefined) clearTimeout(preemptedTimer);
            preemptedTimer = undefined;
            active?.stop();
            found = false;
            activeServiceName = undefined;
            setRelays([]);
            setDiscoveryPhase('scanning');
            try {
                const next = browse({ type: 'muxr' });
                active = next;
                next.on('found', onResolved);
                next.on('updated', onResolved);
                next.on('lost', onRemoved);
                next.on('error', onError);
                next.on('stopped', ({ reason }) => {
                    if (active !== next || reason !== 'preempted') return;
                    active = undefined;
                    clearNoServiceTimer();
                    found = false;
                    setRelays([]);
                    setDiscoveryPhase('scanning');
                    // SSH scan returns the browser as soon as it finishes. If another
                    // caller preempted us, retry after that bounded scan window.
                    preemptedTimer = setTimeout(() => { if (active === undefined) scan(); }, 8_500);
                });
                waitForService();
            } catch (cause) { onError(cause); }
        };
        retryScan = scan;
        const foreground = AppState.addEventListener('change', (state) => { if (state === 'active') scan(); });
        scan();
        return () => {
            clearNoServiceTimer();
            if (preemptedTimer !== undefined) clearTimeout(preemptedTimer);
            if (retryScan === scan) retryScan = undefined;
            foreground.remove();
            active?.stop();
        };
    }, [enabled]);

    return relays;
}

/** Globally reconnect the active machine when mDNS supplies a newly verified locator. */
export function RelayDiscoveryReconnect() {
    const auth = useAuth();
    const settings = getCachedConnectionSettings();
    const nearbyRoute = settings.mode === 'hosted' && settings.selfhost === true
        && /^ws:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(settings.relayUrl);
    const relays = useRelayDiscovery(auth.isAuthenticated && nearbyRoute);

    React.useEffect(() => {
        if (!auth.isAuthenticated || relays.length === 0) return undefined;
        if (getCachedConnectionSettings().relayUrl === relays[0].relayUrl) {
            setDiscoveryPhase('found');
            return undefined;
        }
        let cancelled = false;
        const verify = async () => {
            setDiscoveryPhase('verifying');
            const result = await reconnectMachine({ relays }).catch(() => ({ ok: false as const }));
            if (cancelled) return;
            setDiscoveryPhase(result.ok ? 'updated' : 'unverified');
        };
        void verify();
        return () => { cancelled = true; };
    }, [auth.isAuthenticated, relays]);

    return null;
}
