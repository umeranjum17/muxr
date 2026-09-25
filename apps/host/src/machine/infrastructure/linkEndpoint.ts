import { Host, hostId, keyPairFrom, type Grant } from '@byokit/link';
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
    answer: LinkAnswer;
    onStatus?: (status: string) => void;
}

interface DeviceMeta { muxrDeviceId: string }

const muxrDeviceIdOf = (grant: Grant): string | undefined => {
    const meta = grant.meta as Partial<DeviceMeta> | undefined;
    return typeof meta?.muxrDeviceId === 'string' ? meta.muxrDeviceId : undefined;
};

/**
 * Only native devices move onto the link for now: their grants never expire.
 * Browsers hold 8-hour and 30-day grants, and the link cannot end a grant on a
 * clock yet, so they stay on the relay transport, which does.
 */
function linkDevices(crypto: MachineCryptoState, now: number): MachineDeviceRecord[] {
    return crypto.devices.filter((device) => device.kind === undefined && Date.parse(device.expiresAt) > now);
}

/**
 * The machine on @byokit/link, beside the relay transport. It proves the
 * machine's existing box key to the relay and enrols every paired phone under
 * the key it already holds, so a phone paired before this existed reaches the
 * machine over the link without pairing again.
 *
 * `selfhost.json` stays the only authority: the link's grants are rebuilt from
 * it on start and on every change, so a device revoked there is revoked here.
 */
export class LinkEndpoint {
    private synced: Promise<void> = Promise.resolve();

    private constructor(private readonly host: Host, private readonly client: RelayClient) {}

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
            handle: async (req, grant) => {
                const deviceId = muxrDeviceIdOf(grant);
                if (deviceId === undefined) throw new Error('link: grant without a muxr device');
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op) throw new Error('link: request op does not match its frame');
                return options.answer(frame, deviceId);
            },
        });
        const client = new RelayClient(host, {
            url: new URL('/relay/v1/host', relayControlUrl(options.relayUrl)).toString().replace(/^http/, 'ws'),
            name: options.machineName,
            ...(enrol === undefined ? {} : { enrol }),
            ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
        });
        const endpoint = new LinkEndpoint(host, client);
        await endpoint.sync(options.crypto);
        return endpoint;
    }

    /** Enrol the phones this machine now trusts and revoke the ones it no longer does. */
    sync(crypto: MachineCryptoState): Promise<void> {
        this.synced = this.synced.then(() => this.reconcile(crypto)).catch((error: unknown) => {
            process.stderr.write(`link: device sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
        return this.synced;
    }

    broadcast(frame: HostFrame): void {
        this.host.broadcast(frame);
    }

    close(): void {
        this.client.stop();
        this.host.close();
    }

    private async reconcile(crypto: MachineCryptoState): Promise<void> {
        const wanted = new Map(linkDevices(crypto, Date.now()).map((device) => [device.deviceId, device]));
        const enrolled = new Set<string>();
        for (const grant of this.host.devices()) {
            const deviceId = muxrDeviceIdOf(grant);
            const device = deviceId === undefined ? undefined : wanted.get(deviceId);
            const sameKey = device !== undefined && Buffer.from(device.devicePublicKey, 'base64').toString('base64url') === grant.key;
            if (deviceId !== undefined && sameKey) {
                enrolled.add(deviceId);
                continue;
            }
            await this.host.revoke(grant.id);
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
