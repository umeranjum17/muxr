import * as React from 'react';
import { Platform } from 'react-native';
import { useAuth } from '@/account/ui';
import { getCachedConnectionSettings } from '@/connection';
import { reconnectMachine } from './ReconnectMachine';

export interface DiscoveredRelay {
    name: string;
    machineId: string;
    relayUrl: string;
}

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

function discoveredRelay(service: {
    name?: string;
    addresses?: string[];
    port?: number;
    txt?: Record<string, unknown>;
}): DiscoveredRelay | undefined {
    const machineId = typeof service.txt?.machine === 'string' ? service.txt.machine : undefined;
    const advertised = typeof service.txt?.relay === 'string' ? service.txt.relay : undefined;
    const mode = typeof service.txt?.mode === 'string' ? service.txt.mode : undefined;
    if (service.name === undefined || machineId === undefined) return undefined;
    let relayUrl = advertised;
    if (mode === 'lan') {
        const host = service.addresses?.find((address) => {
            if (typeof address !== 'string') return false;
            const octets = address.split('.').map(Number);
            return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
                && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
        });
        const port = service.port;
        if (host === undefined || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
        relayUrl = `ws://${host}:${port}`;
    }
    if (relayUrl === undefined) return undefined;
    try {
        const parsed = new URL(relayUrl);
        if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
            || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
        return { name: service.name, machineId, relayUrl: parsed.toString().replace(/\/$/, '') };
    } catch {
        return undefined;
    }
}

/** LAN locator scan. A result never authorises a machine; the stored E2EE grant does. */
export function useRelayDiscovery(enabled = true): DiscoveredRelay[] {
    const [relays, setRelays] = React.useState<DiscoveredRelay[]>([]);

    React.useEffect(() => {
        if (Platform.OS === 'web') { setDiscoveryPhase('web'); return undefined; }
        if (!enabled) { setDiscoveryPhase('disabled'); return undefined; }
        let zeroconf: any;
        try {
            const mod = require('react-native-zeroconf');
            zeroconf = new (mod.default ?? mod)();
        } catch {
            setDiscoveryPhase('unavailable');
            return undefined;
        }
        let noServiceTimer: ReturnType<typeof setTimeout> | undefined;
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
        const onResolved = (service: Parameters<typeof discoveredRelay>[0]) => {
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
            found = false;
            activeServiceName = undefined;
            setRelays([]);
            setDiscoveryPhase('scanning');
            try {
                zeroconf.scan('muxr', 'tcp', 'local.');
                waitForService();
            } catch (cause) { onError(cause); }
        };
        const retry = () => {
            try { zeroconf.stop(); }
            catch { /* A fresh scan still has a chance to work. */ }
            scan();
        };
        zeroconf.on('resolved', onResolved);
        zeroconf.on('remove', onRemoved);
        zeroconf.on('error', onError);
        retryScan = retry;
        scan();
        return () => {
            clearNoServiceTimer();
            if (retryScan === retry) retryScan = undefined;
            zeroconf.removeListener('resolved', onResolved);
            zeroconf.removeListener('remove', onRemoved);
            zeroconf.removeListener('error', onError);
            try { zeroconf.stop(); }
            catch { /* shutdown best effort */ }
            zeroconf.removeDeviceListeners();
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
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const verify = async () => {
            setDiscoveryPhase('verifying');
            const result = await reconnectMachine({ relays }).catch(() => ({ ok: false as const }));
            if (cancelled) return;
            setDiscoveryPhase(result.ok ? 'updated' : 'unverified');
            if (!result.ok) retryTimer = setTimeout(() => { void verify(); }, 12_000);
        };
        void verify();
        return () => { cancelled = true; if (retryTimer !== undefined) clearTimeout(retryTimer); };
    }, [auth.isAuthenticated, relays]);

    return null;
}
