/**
 * The locator a discovered mDNS service offers. The relay advertises the dial
 * URL in its txt record (byokit reach's advertise contract) and that URL is
 * the only locator. A result never authorises a machine; the stored grant does.
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
    txt?: Record<string, unknown>;
}): DiscoveredRelay | undefined {
    const machineId = typeof service.txt?.machine === 'string' ? service.txt.machine : undefined;
    const advertised = typeof service.txt?.relay === 'string' ? service.txt.relay : undefined;
    if (service.name === undefined || machineId === undefined) return undefined;
    if (!isPrivateLanUrl(advertised)) return undefined;
    try {
        const parsed = new URL(advertised!);
        if (!parsed.hostname || parsed.username || parsed.password
            || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
        return { name: service.name, machineId, relayUrl: parsed.toString().replace(/\/$/, '') };
    } catch {
        return undefined;
    }
}
