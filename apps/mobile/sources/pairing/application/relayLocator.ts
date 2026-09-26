/**
 * The locator a discovered mDNS service offers. The relay advertises the dial
 * URL in its txt record (byokit reach's advertise contract), so that URL wins;
 * resolving an A record stays as the fallback for a relay that published no
 * reachable LAN URL. A result never authorises a machine; the stored grant does.
 */
export interface DiscoveredRelay {
    name: string;
    machineId: string;
    relayUrl: string;
}

/** A ws:// URL on this machine's private LAN range: the locator reach advertises in txt. */
function isPrivateLanUrl(value: string | undefined): boolean {
    if (value === undefined) return false;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'ws:'
            && /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(parsed.hostname);
    } catch {
        return false;
    }
}

export function discoveredRelay(service: {
    name?: string;
    addresses?: string[];
    port?: number;
    txt?: Record<string, unknown>;
}): DiscoveredRelay | undefined {
    const machineId = typeof service.txt?.machine === 'string' ? service.txt.machine : undefined;
    const advertised = typeof service.txt?.relay === 'string' ? service.txt.relay : undefined;
    const mode = typeof service.txt?.mode === 'string' ? service.txt.mode : undefined;
    if (service.name === undefined || machineId === undefined) return undefined;
    let relayUrl = isPrivateLanUrl(advertised) ? advertised : undefined;
    if (relayUrl === undefined && mode === 'lan') {
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
