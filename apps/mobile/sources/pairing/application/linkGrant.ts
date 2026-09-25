import { hostId, unb64url, type DeviceGrant } from '@byokit/link';
import type { StoredHostedGrant } from './hostedE2ee';

/** byokit keys are base64url; the stored grant keeps the same bytes as plain base64. */
const toBase64Url = (value: string): string => value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The byokit link grant this phone can dial with no pairing step: its stored
 * device key is a link key, the machine's box key pins the host, and the
 * self-host relay serves the link route beside the existing transport
 * (decision D2: enrolment is host-side, so the phone derives everything it
 * already holds). `undefined` when this machine has no link to offer —
 * hosted relays and legacy grants stay on the relay transport.
 */
export function deriveLinkGrant(grant: StoredHostedGrant | undefined): DeviceGrant | undefined {
    if (grant?.source !== 'selfhost') return undefined;
    if (typeof grant.deviceKey?.secretKey !== 'string' || typeof grant.machineBoxPublicKey !== 'string') return undefined;
    try {
        const hostKey = unb64url(toBase64Url(grant.machineBoxPublicKey));
        const relay = new URL(grant.relayUrl);
        // The relay mounts the link route at its origin, like byokit's own
        // short-code lookup; a subpath in the relay URL belongs to the old transport.
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
