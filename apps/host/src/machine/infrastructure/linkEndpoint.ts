import { Host, PublicLinkError, hostId, keyPairFrom, type Grant } from '@byokit/link';
import { RelayClient } from '@byokit/relay';
import { parseClientFrame, relayControlUrl, type ClientFrame, type HostFrame } from '@muxr/contract';
import type { MachineCryptoState, MachineDeviceRecord } from '../domain/crypto.js';

/** How the host answers one device's frame: the same answer the relay transport sends back. */
export type LinkAnswer = (frame: ClientFrame, deviceId: string) => Promise<HostFrame | undefined>;

export interface LinkEndpointOptions {
    /** The machine's relay socket URL, e.g. ws://127.0.0.1:8792/relay. */
    relayUrl: string;
    /** The relay owner's secret; a host without it (a shared relay) has no link endpoint. */
    ownerToken: string;
    machineName: string;
    crypto: MachineCryptoState;
    currentCrypto: () => MachineCryptoState | undefined;
    answer: LinkAnswer;
    canView: (frame: ClientFrame) => boolean;
    onStatus?: (status: string) => void;
}

interface DeviceMeta { muxrDeviceId: string }

const muxrDeviceIdOf = (grant: Grant): string | undefined => {
    const meta = grant.meta as Partial<DeviceMeta> | undefined;
    return typeof meta?.muxrDeviceId === 'string' ? meta.muxrDeviceId : undefined;
};

/**
 * Only native devices are enrolled here. Browser grants expire after 8 hours
 * or 30 days, so browsers stay on the existing relay transport. The live
 * device-table check below also enforces native device expiry.
 */
function linkDevices(crypto: MachineCryptoState, now: number): MachineDeviceRecord[] {
    return crypto.devices.filter((device) => device.kind === undefined && device.deviceId !== crypto.pendingRotation?.revokedDeviceId
        && Date.parse(device.expiresAt) > now);
}

function trusted(grant: Grant, crypto: MachineCryptoState | undefined): boolean {
    if (crypto === undefined) return false;
    const deviceId = muxrDeviceIdOf(grant);
    const device = linkDevices(crypto, Date.now()).find((entry) => entry.deviceId === deviceId);
    return device !== undefined && Buffer.from(device.devicePublicKey, 'base64').toString('base64url') === grant.key
        && (device.authority === 'observe' ? 'view' : 'control') === grant.role;
}

/**
 * The machine on @byokit/link, beside the relay transport. It proves the
 * machine's existing box key to the relay and enrols native phones under
 * their existing keys, so a future link client can reuse its pairing.
 *
 * `selfhost.json` stays the only authority. Grants are reconciled on changes,
 * while admission, replies and broadcasts check the live device table so a
 * revoked device cannot use a stale grant before reconciliation.
 */
export class LinkEndpoint {
    private synced: Promise<boolean> = Promise.resolve(true);

    private client?: RelayClient;

    private constructor(private readonly host: Host,
        private readonly currentCrypto: () => MachineCryptoState | undefined,
        private readonly connectRelay: () => RelayClient) {}

    static async open(options: LinkEndpointOptions): Promise<LinkEndpoint | undefined> {
        const keys = keyPairFrom(Buffer.from(options.crypto.boxSecretKey, 'base64'));
        if (Buffer.from(keys.publicKey).toString('base64') !== options.crypto.boxPublicKey) {
            throw new Error('link: the machine box key pair does not match');
        }
        const enrol = await relayEnrolment(options.relayUrl, options.ownerToken, hostId(keys.publicKey), options.machineName);
        if (enrol === false) return undefined;
        const host = await Host.open({
            keys,
            name: options.machineName,
            // Pairing stays on the relay transport; the link only admits phones
            // enrolled from this machine's own device records.
            confirm: () => false,
            allow: (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) return false;
                const frame = parseClientFrame(req.args);
                return frame.type === req.op && (frame.type.startsWith('desktop.') || grant.role === 'control' || options.canView(frame));
            },
            handle: async (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) throw new Error('link: device no longer trusted');
                const deviceId = muxrDeviceIdOf(grant)!;
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op) throw new Error('link: request op does not match its frame');
                if (frame.type.startsWith('desktop.')) {
                    throw new PublicLinkError('Remote desktop is not available over this link yet; use the existing relay connection.');
                }
                const response = await options.answer(frame, deviceId);
                if (!trusted(grant, options.currentCrypto())) throw new Error('link: device no longer trusted');
                return response;
            },
        });
        const endpoint = new LinkEndpoint(host, options.currentCrypto, () => new RelayClient(host, {
            url: new URL('/relay/v1/host', relayControlUrl(options.relayUrl)).toString().replace(/^http/, 'ws'),
            name: options.machineName,
            ...(enrol === undefined ? {} : { enrol }),
            ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
        }));
        if (!await endpoint.sync(options.crypto)) throw new Error('link: initial device sync failed');
        return endpoint;
    }

    start(): void {
        this.client = this.connectRelay();
    }

    /** Enrol the phones this machine now trusts and revoke the ones it no longer does. */
    sync(crypto: MachineCryptoState): Promise<boolean> {
        this.synced = this.synced.then(async () => {
            await this.reconcile(crypto);
            return true;
        }).catch((error: unknown) => {
            process.stderr.write(`link: device sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
            return false;
        });
        return this.synced;
    }

    enrolledKey(deviceId: string): string | undefined {
        const crypto = this.currentCrypto();
        const grant = this.host.devices().find((entry) => muxrDeviceIdOf(entry) === deviceId && trusted(entry, crypto));
        return grant === undefined ? undefined : Buffer.from(grant.key, 'base64url').toString('base64');
    }

    broadcast(frame: HostFrame): void {
        const crypto = this.currentCrypto();
        this.host.broadcast(frame, (grant) => trusted(grant, crypto));
    }

    close(): void {
        this.client?.stop();
        this.host.close();
    }

    private async reconcile(crypto: MachineCryptoState): Promise<void> {
        const wanted = new Map(linkDevices(crypto, Date.now()).map((device) => [device.deviceId, device]));
        const enrolled = new Set<string>();
        for (const grant of this.host.devices()) {
            const deviceId = muxrDeviceIdOf(grant);
            const device = deviceId === undefined ? undefined : wanted.get(deviceId);
            const sameKey = device !== undefined && Buffer.from(device.devicePublicKey, 'base64').toString('base64url') === grant.key;
            const roleMatches = device !== undefined && (device.authority === 'observe' ? 'view' : 'control') === grant.role;
            // A grant whose device or key is gone is a real removal: the phone
            // is told `removed`, and that is then true. A grant whose only lag
            // is its role stays for the enrol below, which replaces grants by
            // key through a change that does not notify removal, so a live
            // session is moved to the new role instead of being ended as
            // removed and wiping the phone's stored pairing.
            if (device === undefined || !sameKey) await this.host.revoke(grant.id);
            else if (roleMatches) enrolled.add(device.deviceId);
        }
        for (const device of wanted.values()) {
            if (enrolled.has(device.deviceId)) continue;
            await this.host.enrol({
                key: Buffer.from(device.devicePublicKey, 'base64'),
                name: 'Paired phone',
                role: device.authority === 'observe' ? 'view' : 'control',
                meta: { muxrDeviceId: device.deviceId } satisfies DeviceMeta,
            });
        }
    }
}

/**
 * The relay admits a host only once its owner vouches for the key. This host
 * is the owner of its own relay (it holds the mint secret), so it asks for a
 * one-use enrolment the first time and never again. `false`: not the owner.
 */
async function relayEnrolment(relayUrl: string, ownerToken: string, id: string, name: string): Promise<string | undefined | false> {
    const base = relayControlUrl(relayUrl);
    const headers = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' };
    const listed = await fetch(new URL('/relay/v1/hosts', base), { headers });
    if (listed.status === 403 || listed.status === 404) return false;
    if (!listed.ok) throw new Error(`link: relay host list failed (${listed.status})`);
    const hosts = await listed.json() as unknown;
    const known = Array.isArray(hosts) ? hosts : (hosts as { hosts?: unknown }).hosts;
    if (Array.isArray(known) && known.some((host) => (host as { id?: unknown }).id === id)) return undefined;
    const created = await fetch(new URL('/relay/v1/enrolments', base), { method: 'POST', headers, body: JSON.stringify({ name }) });
    if (!created.ok) throw new Error(`link: relay enrolment failed (${created.status})`);
    const { token } = await created.json() as { token?: unknown };
    if (typeof token !== 'string') throw new Error('link: relay enrolment returned no token');
    return token;
}
