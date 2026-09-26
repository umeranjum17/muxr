import { Host, PublicLinkError, hostId, keyPairFrom, type Grant } from '@byokit/link';
import { isExpoToken, RelayClient } from '@byokit/relay';
import {
    lifecycleNotificationAllowed,
    parseClientFrame,
    parseLifecycleNotificationLevel,
    relayControlUrl,
    type ClientFrame,
    type HostFrame,
    type LifecycleNotificationLevel,
} from '@muxr/contract';
import type { MachineCryptoState, MachineDeviceRecord } from '../domain/crypto.js';

/** How the host answers one device's frame: the same answer the relay transport sends back. */
export type LinkAnswer = (frame: ClientFrame, deviceId: string) => Promise<HostFrame | undefined>;

export interface LinkEndpointOptions {
    /** The machine's relay socket URL, e.g. ws://127.0.0.1:8792/relay. */
    relayUrl: string;
    /** The relay owner's secret; with it the host mints its own link enrolment. */
    ownerToken?: string;
    /** A one-use enrolment minted by the owner of a shared relay; after the
     *  first registration this host's key is enough, and the token is ignored. */
    enrol?: string;
    /** This machine's id; rides push notifications so the phone can claim them. */
    machineId?: string;
    machineName: string;
    crypto: MachineCryptoState;
    currentCrypto: () => MachineCryptoState | undefined;
    answer: LinkAnswer;
    canView: (frame: ClientFrame) => boolean;
    onStatus?: (status: string) => void;
}

interface DeviceMeta { muxrDeviceId: string }

/** Kept in step with the relay's push builder — same copy for both transports. */
const COPY_SUFFIX: Record<string, string> = {
    blocked: ' needs attention.',
    done: ' finished.',
    failed: ' failed.',
};

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

    /** Lifecycle level each link device asked for when it registered its push address. */
    private readonly pushLevels = new Map<string, LifecycleNotificationLevel>();

    private constructor(private readonly host: Host,
        private readonly currentCrypto: () => MachineCryptoState | undefined,
        private readonly connectRelay: () => RelayClient,
        private readonly machineId?: string) {}

    static async open(options: LinkEndpointOptions): Promise<LinkEndpoint | undefined> {
        const keys = keyPairFrom(Buffer.from(options.crypto.boxSecretKey, 'base64'));
        if (Buffer.from(keys.publicKey).toString('base64') !== options.crypto.boxPublicKey) {
            throw new Error('link: the machine box key pair does not match');
        }
        const enrol = options.enrol !== undefined ? options.enrol
            : options.ownerToken === undefined ? false
            : await relayEnrolment(options.relayUrl, options.ownerToken, hostId(keys.publicKey), options.machineName);
        if (enrol === false) return undefined;
        // Device connections start only after the client dials, which is after
        // this assignment; the push handler needs the finished endpoint.
        let subscribePush: LinkEndpoint['subscribePush'] | undefined;
        const host = await Host.open({
            keys,
            name: options.machineName,
            // Pairing stays on the relay transport; the link only admits phones
            // enrolled from this machine's own device records.
            confirm: () => false,
            allow: (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) return false;
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op) return false;
                // A device's own push address is device-local, never machine data.
                return frame.type === 'push.subscribe' || frame.type.startsWith('desktop.')
                    || grant.role === 'control' || options.canView(frame);
            },
            handle: async (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) throw new Error('link: device no longer trusted');
                const deviceId = muxrDeviceIdOf(grant)!;
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op) throw new Error('link: request op does not match its frame');
                if (frame.type === 'push.subscribe') return subscribePush!(frame, grant, deviceId);
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
        }), options.machineId);
        subscribePush = (frame, grant, deviceId) => endpoint.subscribePush(frame, grant, deviceId);
        if (!await endpoint.sync(options.crypto)) {
            endpoint.close();
            throw new Error('link: initial device sync failed');
        }
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

    /**
     * Fan one lifecycle notification out to the link devices that asked to be
     * woken for it. The same payload the relay pushes for pre-link devices;
     * each device lives in exactly one push store, so nobody gets two.
     */
    notifyAttention(input: {
        sessionId: string;
        eventId: string;
        kind: 'blocked' | 'done' | 'failed';
        machineId: string;
        reasonCode?: string;
        agentName?: string;
        taskTitle?: string;
    }): void {
        if (input.agentName === undefined || this.client === undefined) return;
        const to = [...this.pushLevels]
            .filter(([, level]) => lifecycleNotificationAllowed(level, input.kind))
            .map(([grantId]) => grantId);
        if (to.length === 0) return;
        const title = input.taskTitle ?? 'Agent update';
        const suffix = input.kind === 'failed' && COPY_SUFFIX.failed !== undefined && input.reasonCode !== undefined
            && ['start-launch-failed', 'start-timeout', 'squad-rolled-back', 'agent-unavailable'].includes(input.reasonCode)
            ? ' could not start.'
            : COPY_SUFFIX[input.kind];
        void this.client.notify({
            id: input.eventId,
            title,
            body: `${input.agentName}${suffix}`,
            data: {
                eventId: input.eventId,
                kind: input.kind,
                reasonCode: input.reasonCode,
                agentName: input.agentName,
                ...(input.taskTitle === undefined ? {} : { taskTitle: input.taskTitle }),
                sessionId: input.sessionId,
                machineId: input.machineId,
                presentationOwner: 'relay-push',
            },
            to,
            urgency: input.kind === 'blocked' ? 'high' : 'normal',
        }, { includeContent: true }).catch((cause: unknown) => {
            process.stderr.write(`link: push notify failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        });
    }

    /**
     * Store one device's Expo push address on the relay and remember the level
     * it asked for. `deviceId` is currently only informational (the grant id is
     * the relay-side key); keeping it in the signature documents the mapping.
     */
    private async subscribePush(frame: ClientFrame, grant: Grant, deviceId: string): Promise<HostFrame> {
        if (frame.type !== 'push.subscribe') throw new Error('link: not a push registration');
        if (!isExpoToken(frame.params.token)) throw new PublicLinkError('push.subscribe needs an Expo push token');
        const level = frame.params.level === undefined ? undefined : parseLifecycleNotificationLevel(frame.params.level);
        if (frame.params.level !== undefined && level === undefined) throw new PublicLinkError('push.subscribe level is invalid');
        if (this.client === undefined) throw new PublicLinkError('push.subscribe needs the relay connection; retry when it is online');
        await this.client.subscribe(grant.id, { expo: frame.params.token });
        this.pushLevels.set(grant.id, level ?? 'important');
        return { type: 'result', requestId: frame.requestId, ok: true, data: null };
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
            // A role-only change keeps the pairing: the phone reconnects under
            // the new grant without being told it was removed.
            if (device === undefined || !sameKey) {
                await this.client?.revoke(grant.id);
                this.pushLevels.delete(grant.id);
            } else if (roleMatches) {
                enrolled.add(device.deviceId);
            } else {
                // The device re-enrols under the new role below and its push
                // level resets; it re-registers the address when it reconnects.
                this.pushLevels.delete(grant.id);
            }
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
