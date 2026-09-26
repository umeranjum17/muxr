import * as React from 'react';
import type { BrowseHandle, BrowseService } from '@byokit/reach';
import { Item } from '@/components/Item';
import { retryRelayDiscovery } from '@/pairing';

/**
 * LAN scan for SSH servers, offered where the host is typed. Uses reach's
 * shared mDNS browser on `_ssh._tcp`; typing an address remains the fallback.
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
    const activeRef = React.useRef<{ handle: BrowseHandle; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

    React.useEffect(() => () => {
        const active = activeRef.current;
        if (active === undefined) return;
        clearTimeout(active.timer);
        active.handle.stop();
        retryRelayDiscovery();
    }, []);

    const startScan = React.useCallback(() => {
        try {
            const { browse } = require('@byokit/reach') as typeof import('@byokit/reach');
            const handle = browse({ type: 'ssh' });
            setPhase('scanning');
            setResults([]);
            const finish = (phase: 'done' | 'failed', resumeNearby = true) => {
                if (activeRef.current?.handle !== handle) return;
                clearTimeout(activeRef.current.timer);
                activeRef.current = undefined;
                handle.stop();
                setPhase(phase);
                if (resumeNearby) retryRelayDiscovery();
            };
            const timer = setTimeout(() => finish('done'), 8_000);
            activeRef.current = { handle, timer };
            const onResolved = ({ name, addresses, port }: BrowseService) => {
                const host = pickLanAddress(addresses);
                if (host === undefined) return;
                const resolvedPort = port || 22;
                setResults((current) => current.some((r) => r.host === host && r.port === resolvedPort)
                    ? current
                    : [...current, { name, host, port: resolvedPort }]);
            };
            handle.on('found', onResolved);
            handle.on('updated', onResolved);
            handle.on('error', () => finish('failed'));
            handle.on('stopped', () => finish('failed', false));
        } catch {
            setPhase('failed');
            retryRelayDiscovery();
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
