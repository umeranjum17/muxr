import * as React from 'react';
import { Platform } from 'react-native';

export interface DiscoveredRelay {
    name: string;
    host: string;
    port: number;
}

/**
 * LAN discovery for self-host relays via mDNS (_muxr._tcp). The relay advertises
 * itself (bonjour); the app scans. Web and unsupported native builds return [].
 */
export function useRelayDiscovery(): DiscoveredRelay[] {
    const [relays, setRelays] = React.useState<DiscoveredRelay[]>([]);

    React.useEffect(() => {
        if (Platform.OS === 'web') return undefined;
        let zeroconf: any;
        try {
            // require lazily: the native module is absent in unsupported builds
            const mod = require('react-native-zeroconf');
            zeroconf = new (mod.default ?? mod)();
        } catch {
            return undefined;
        }
        const onResolved = (service: { name?: string; addresses?: string[]; port?: number }) => {
            const host = service.addresses?.find((a) => a.includes('.'));
            const name = service.name;
            const port = service.port;
            if (name === undefined || host === undefined || port === undefined) return;
            setRelays((current): DiscoveredRelay[] => current.some((r) => r.name === name && r.host === host)
                ? current
                : [...current, { name, host, port }]);
        };
        zeroconf.on('resolved', onResolved);
        try {
            zeroconf.scan('muxr', 'tcp', 'local.');
        } catch {
            return undefined;
        }
        return () => {
            try {
                zeroconf.stop();
                zeroconf.removeListener('resolved', onResolved);
            } catch { /* shutdown best effort */ }
        };
    }, []);

    return relays;
}
