import * as React from 'react';
import { Platform } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { reconnectViaDiscoveredRelay } from '@/state/hostedE2ee';
import { syncReconnect } from '@/sync/sync';

export interface DiscoveredRelay {
    name: string;
    machineId: string;
    relayUrl: string;
}

function discoveredRelay(service: {
    name?: string;
    addresses?: string[];
    port?: number;
    txt?: Record<string, unknown>;
}): DiscoveredRelay | undefined {
    const host = service.addresses?.find((address) => address.includes('.'));
    const machineId = typeof service.txt?.machine === 'string' ? service.txt.machine : undefined;
    const advertised = typeof service.txt?.relay === 'string' ? service.txt.relay : undefined;
    const mode = typeof service.txt?.mode === 'string' ? service.txt.mode : undefined;
    if (service.name === undefined || host === undefined || service.port === undefined || machineId === undefined) return undefined;
    const relayUrl = mode === 'lan' ? `ws://${host}:${service.port}` : advertised;
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
        if (!enabled || Platform.OS === 'web') return undefined;
        let zeroconf: any;
        try {
            const mod = require('react-native-zeroconf');
            zeroconf = new (mod.default ?? mod)();
        } catch {
            return undefined;
        }
        const onResolved = (service: Parameters<typeof discoveredRelay>[0]) => {
            const relay = discoveredRelay(service);
            if (relay === undefined) return;
            // Resolved events are also our retry clock if a relay was still
            // starting when the first verified-grant probe ran.
            setRelays((current) => [
                ...current.filter((entry) => entry.machineId !== relay.machineId),
                relay,
            ]);
        };
        zeroconf.on('resolved', onResolved);
        try {
            zeroconf.scan('muxr', 'tcp', 'local.');
        } catch {
            zeroconf.removeListener('resolved', onResolved);
            return undefined;
        }
        return () => {
            try {
                zeroconf.stop();
                zeroconf.removeListener('resolved', onResolved);
            } catch { /* shutdown best effort */ }
        };
    }, [enabled]);

    return relays;
}

/** Globally reconnect the active machine when mDNS supplies a newly verified locator. */
export function RelayDiscoveryReconnect() {
    const auth = useAuth();
    const relays = useRelayDiscovery(auth.isAuthenticated);
    const running = React.useRef(false);

    React.useEffect(() => {
        if (!auth.isAuthenticated || running.current || relays.length === 0) return;
        running.current = true;
        void (async () => {
            for (const relay of relays) {
                if (await reconnectViaDiscoveredRelay(relay.machineId, relay.relayUrl)) {
                    await syncReconnect();
                    break;
                }
            }
        })().catch(() => undefined).finally(() => { running.current = false; });
    }, [auth.isAuthenticated, relays]);

    return null;
}
