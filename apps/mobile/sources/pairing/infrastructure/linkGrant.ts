import { hostId, unb64url, type DeviceGrant } from '@byokit/link';
import type { StoredHostedGrant } from '../application/hostedE2ee';

/** byokit keys are base64url; the stored grant keeps the same bytes as plain base64. */
const toBase64Url = (value: string): string => value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The paired device's link grant: its stored key pins the host's box key.
 * No muxr relay transport is available when a link grant is missing.
 */
export function deriveLinkGrant(grant: StoredHostedGrant | undefined, relayUrl?: string): DeviceGrant | undefined {
    if (grant?.source !== 'selfhost') return undefined;
    if (typeof grant.deviceKey?.secretKey !== 'string' || typeof grant.machineBoxPublicKey !== 'string') return undefined;
    try {
        const hostKey = unb64url(toBase64Url(grant.machineBoxPublicKey));
        const relay = new URL(relayUrl ?? grant.relayUrl);
        // The relay mounts the link route at its origin, like byokit's own
        // short-code lookup; a subpath in the relay URL is not part of this route.
        const url = `${relay.protocol === 'wss:' ? 'wss' : 'ws'}://${relay.host}/link/v1/${hostId(hostKey)}`;
        return {
            v: 1,
            secretKey: toBase64Url(grant.deviceKey.secretKey),
            host: toBase64Url(grant.machineBoxPublicKey),
            hostName: grant.machineName ?? 'your computer',
            urls: [url],
            device: {
                id: '',
                name: 'Phone',
                role: grant.authority === 'observe' ? 'view' : 'control',
            },
        };
    } catch {
        return undefined;
    }
}
