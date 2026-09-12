import { generateKeyPair, verifyDeviceGrant, type KeyPair, type SealedDeviceGrant } from '@muxr/crypto';
import { sync } from '@/catalog/sync';
import { getCachedHostedGrant } from './application/hostedE2ee';
export * from './application/hostedE2ee';

/**
 * The separately pinned browser-service grant: per-device roots the browser
 * service and this device share, never the session root. Hosted pairing pins
 * it; an owner device that holds control authority may also enroll itself
 * over the encrypted control plane, which is what happens here on first use.
 */
export interface BrowserServiceGrant {
    /** The browser service's own identity id (the `machineId` of its grant). */
    serviceId: string;
    deviceId: string;
    keyVersion: number;
    /** 32-byte roots from the opened browser-service grant, base64: service->device and device->service. */
    dataKey: string;
    ingressKey: string;
    expiresAt: number;
}

// ponytail: in-memory per machine. Persist beside the hosted grant (the
// pairing lane's store) so a reload does not re-enroll; the service rotates
// the key generation on every enrollment, which is harmless but chatty.
const enrolled = new Map<string, BrowserServiceGrant>();
const pending = new Map<string, Promise<BrowserServiceGrant>>();
let deviceKey: KeyPair | undefined;

export function getBrowserServiceGrant(machineId: string): BrowserServiceGrant | undefined {
    const pinned = getCachedHostedGrant(machineId) as ({ browserService?: BrowserServiceGrant } | undefined);
    const grant = pinned?.browserService ?? enrolled.get(machineId);
    return grant !== undefined && grant.expiresAt > Date.now() ? grant : undefined;
}

/**
 * Enroll this device with the machine's browser service and open the grant
 * it mints. The service signs with its own identity and seals to this
 * device's X25519 key; the signer is checked against the key the service
 * reports in the same encrypted reply (trust on first enrollment -- hosted
 * pairing pins it out of band).
 */
export function enrollBrowserService(machineId: string): Promise<BrowserServiceGrant> {
    const existing = getBrowserServiceGrant(machineId);
    if (existing !== undefined) return Promise.resolve(existing);
    const inFlight = pending.get(machineId);
    if (inFlight !== undefined) return inFlight;
    const work = (async (): Promise<BrowserServiceGrant> => {
        deviceKey ??= generateKeyPair();
        const reply = await sync.request('browser.session.enroll', { devicePublicKey: deviceKey.publicKey });
        const opened = verifyDeviceGrant(reply.grant as SealedDeviceGrant, {
            pinnedMachineSigningPublicKey: reply.signingPublicKey,
            deviceKey,
        });
        const grant: BrowserServiceGrant = {
            serviceId: opened.machineId,
            deviceId: opened.deviceId,
            keyVersion: opened.keyVersion,
            dataKey: opened.dataKey,
            ingressKey: opened.ingressKey,
            expiresAt: opened.expiresAt,
        };
        enrolled.set(machineId, grant);
        return grant;
    })();
    pending.set(machineId, work);
    return work.finally(() => pending.delete(machineId));
}
