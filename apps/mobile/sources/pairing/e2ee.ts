import { getCachedHostedGrant } from './application/hostedE2ee';
export * from './application/hostedE2ee';

/**
 * The separately pinned browser-service grant: a per-device root the
 * browser service and this device share, never the session root. The PWA
 * lane pins it during pairing; until then it is absent and the Agent
 * browser asks for a fresh pairing instead of pretending to be private.
 */
export interface BrowserServiceGrant {
    /** 32-byte root, base64. */
    root: string;
    serviceId: string;
    deviceId: string;
    keyVersion: number;
}

// ponytail: stub reading an optional field of the stored grant; the pairing
// lane replaces this with its pinned store without touching callers.
export function getBrowserServiceGrant(machineId: string): BrowserServiceGrant | undefined {
    const grant = getCachedHostedGrant(machineId) as ({ browserService?: BrowserServiceGrant } | undefined);
    return grant?.browserService;
}
