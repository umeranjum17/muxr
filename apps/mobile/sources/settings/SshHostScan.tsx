import * as React from 'react';
import { Item } from '@/components/Item';

/**
 * LAN scan for SSH servers, offered where the host is typed. Reuses the
 * already-installed zeroconf discovery from Nearby reconnection, pointed at
 * the standard `_ssh._tcp` service instead of the muxr relay. A machine only
 * appears if it advertises SSH over Bonjour; typing an address by hand stays
 * the fallback.
 */

interface SshScanResult {
    name: string;
    host: string;
    port: number;
}

function pickLanAddress(addresses: unknown): string | undefined {
    if (!Array.isArray(addresses)) return undefined;
    // Prefer a dotted IPv4 in a private range over IPv6 noise.
    const ipv4 = addresses.find((address): address is string => typeof address === 'string'
        && /^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(address));
    return ipv4 ?? addresses.find((address): address is string => typeof address === 'string' && address.includes('.'));
}

export function SshHostScan({ onPick, disabled }: {
    onPick: (host: string, port?: number) => void;
    disabled?: boolean;
}) {
    const [phase, setPhase] = React.useState<'idle' | 'scanning' | 'done' | 'failed'>('idle');
    const [results, setResults] = React.useState<SshScanResult[]>([]);
    const activeRef = React.useRef<{ zeroconf: any; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

    React.useEffect(() => () => {
        const active = activeRef.current;
        if (active === undefined) return;
        clearTimeout(active.timer);
        try { active.zeroconf.stop(); } catch { /* leaving mid-scan */ }
        active.zeroconf?.removeDeviceListeners?.();
    }, []);

    const startScan = React.useCallback(() => {
        let zeroconf: any;
        try {
            const mod = require('react-native-zeroconf');
            zeroconf = new (mod.default ?? mod)();
        } catch {
            setPhase('failed');
            return;
        }
        setPhase('scanning');
        setResults([]);
        const timer = setTimeout(() => {
            try { zeroconf.stop(); } catch { /* results so far are fine */ }
            activeRef.current = undefined;
            setPhase((current) => current === 'scanning' ? 'done' : current);
            cleanup();
        }, 8_000);
        activeRef.current = { zeroconf, timer };
        const onResolved = (service: { name?: string; addresses?: string[]; port?: number }) => {
            const { name, addresses, port } = service;
            const host = pickLanAddress(addresses);
            if (name === undefined || host === undefined) return;
            const resolvedPort = typeof port === 'number' ? port : 22;
            setResults((current) => current.some((r) => r.host === host && r.port === resolvedPort)
                ? current
                : [...current, { name, host, port: resolvedPort }]);
        };
        const onError = () => setPhase('failed');
        function cleanup() {
            clearTimeout(timer);
            if (activeRef.current?.timer === timer) activeRef.current = undefined;
            zeroconf?.removeListener('resolved', onResolved);
            zeroconf?.removeListener('error', onError);
            zeroconf?.removeDeviceListeners();
        }
        zeroconf.on('resolved', onResolved);
        zeroconf.on('error', onError);
        try {
            zeroconf.scan('ssh', 'tcp', 'local.');
        } catch {
            clearTimeout(timer);
            setPhase('failed');
            cleanup();
        }
    }, []);

    const subtitle = phase === 'idle' ? 'Find servers advertising SSH on this Wi-Fi'
        : phase === 'scanning' ? 'Scanning this network for SSH servers…'
            : phase === 'failed' ? 'Scan failed. Check Wi-Fi and retry.'
                : results.length === 0 ? 'No SSH servers announced on this network. Type the host by hand.'
                    : `${results.length} server${results.length === 1 ? '' : 's'} found`;

    return (
        <>
            <Item
                title={phase === 'scanning' ? 'Scanning…' : 'Scan for SSH servers'}
                subtitle={subtitle}
                onPress={phase === 'scanning' || disabled === true ? undefined : startScan}
            />
            {results.map((result) => (
                <Item
                    key={`${result.host}:${result.port}`}
                    title={result.name}
                    subtitle={`${result.host}:${result.port}`}
                    onPress={() => onPick(result.host, result.port)}
                />
            ))}
        </>
    );
}
