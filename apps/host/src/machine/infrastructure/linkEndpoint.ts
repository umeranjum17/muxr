import { randomUUID } from 'node:crypto';
import { Host, PublicLinkError, hostId, keyPairFrom, type Grant, type LinkRequest, type LinkStream } from '@byokit/link';
import { RelayClient } from '@byokit/relay';
import { parseClientFrame, relayControlUrl, type ClientFrame, type HostFrame } from '@muxr/contract';
import type { MachineCryptoState, MachineDeviceRecord } from '../domain/crypto.js';

/** How the host answers one device's frame: the same answer the relay transport sends back. */
export type LinkAnswer = (frame: ClientFrame, deviceId: string, connectionId?: string) => Promise<HostFrame | undefined>;

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
    onDesktopConnection?: (connectionId: string, active: boolean) => void;
    onDeviceConnection?: (deviceId: string, active: boolean) => void;
    onDeviceRevoked?: (deviceId: string) => void | Promise<void>;
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
    private connectionTimer?: ReturnType<typeof setInterval>;
    private readonly deviceConnections = new Map<string, boolean>();

    private constructor(private readonly host: Host,
        private readonly currentCrypto: () => MachineCryptoState | undefined,
        private readonly connectRelay: () => RelayClient,
        private readonly onDeviceConnection?: (deviceId: string, active: boolean) => void,
        private readonly onDeviceRevoked?: (deviceId: string) => void | Promise<void>) {}

    static async open(options: LinkEndpointOptions): Promise<LinkEndpoint | undefined> {
        const keys = keyPairFrom(Buffer.from(options.crypto.boxSecretKey, 'base64'));
        if (Buffer.from(keys.publicKey).toString('base64') !== options.crypto.boxPublicKey) {
            throw new Error('link: the machine box key pair does not match');
        }
        const enrol = await relayEnrolment(options.relayUrl, options.ownerToken, hostId(keys.publicKey), options.machineName);
        if (enrol === false) return undefined;
        const host = await Host.open({
            stream: (stream, req, grant) => streamDesktop(stream, req, grant, options),
            keys,
            name: options.machineName,
            // Pairing stays on the relay transport; the link only admits phones
            // enrolled from this machine's own device records.
            confirm: () => false,
            allow: (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) return false;
                if (req.op === 'desktop') return true;
                const frame = parseClientFrame(req.args);
                return frame.type === req.op && !frame.type.startsWith('desktop.')
                    && (grant.role === 'control' || options.canView(frame));
            },
            handle: async (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) throw new Error('link: device no longer trusted');
                const deviceId = muxrDeviceIdOf(grant)!;
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op) throw new Error('link: request op does not match its frame');
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
        }), options.onDeviceConnection, options.onDeviceRevoked);
        if (!await endpoint.sync(options.crypto)) {
            endpoint.close();
            throw new Error('link: initial device sync failed');
        }
        return endpoint;
    }

    start(): void {
        this.client = this.connectRelay();
        this.updateDeviceConnections();
        // ponytail: poll the public online snapshot; switch to connection events if byokit adds them.
        this.connectionTimer = setInterval(() => this.updateDeviceConnections(), 500);
        this.connectionTimer.unref?.();
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
        if (this.connectionTimer !== undefined) clearInterval(this.connectionTimer);
        for (const [deviceId, active] of this.deviceConnections) {
            if (active) this.onDeviceConnection?.(deviceId, false);
        }
        this.deviceConnections.clear();
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
                await this.host.revoke(grant.id);
                if (deviceId !== undefined) {
                    this.deviceConnections.delete(deviceId);
                    this.onDeviceConnection?.(deviceId, false);
                    await this.onDeviceRevoked?.(deviceId);
                }
            } else if (roleMatches) enrolled.add(device.deviceId);
            else if (deviceId !== undefined) await this.onDeviceRevoked?.(deviceId);
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

    private updateDeviceConnections(): void {
        const crypto = this.currentCrypto();
        const seen = new Set<string>();
        for (const grant of this.host.devices()) {
            const deviceId = muxrDeviceIdOf(grant);
            if (deviceId === undefined || !trusted(grant, crypto)) continue;
            seen.add(deviceId);
            if (this.deviceConnections.get(deviceId) === grant.online) continue;
            this.deviceConnections.set(deviceId, grant.online);
            this.onDeviceConnection?.(deviceId, grant.online);
        }
        for (const [deviceId, online] of this.deviceConnections) {
            if (seen.has(deviceId) || !online) continue;
            this.deviceConnections.set(deviceId, false);
            this.onDeviceConnection?.(deviceId, false);
        }
    }
}

/** One stream carries desktop signaling RPC frames; the WebRTC media path is unchanged. */
async function streamDesktop(stream: LinkStream, req: LinkRequest, grant: Grant, options: LinkEndpointOptions): Promise<void> {
    if (req.op !== 'desktop' || !trusted(grant, options.currentCrypto())) {
        throw new PublicLinkError('desktop: device is no longer trusted');
    }
    const deviceId = muxrDeviceIdOf(grant)!;
    const connectionId = `link:${deviceId}:${randomUUID()}`;
    let buffer = '';
    const decoder = new TextDecoder();
    let work = Promise.resolve();
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => { finish = resolve; });
    options.onDeviceConnection?.(deviceId, true);
    options.onDesktopConnection?.(connectionId, true);
    stream.onEnd = () => finish();
    stream.onData = (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 1_000_000) { stream.end('desktop signaling request too large'); return; }
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            work = work.then(async () => {
                let frame: ClientFrame;
                try { frame = parseClientFrame(JSON.parse(line)); }
                catch { stream.end('malformed desktop signaling request'); return; }
                if (!('requestId' in frame)) { stream.end('invalid desktop signaling request'); return; }
                if (!frame.type.startsWith('desktop.')) {
                    await stream.write(JSON.stringify({ type: 'result', requestId: frame.requestId, ok: false, error: 'only desktop signaling is allowed on this stream' }) + '\n');
                    return;
                }
                if (!trusted(grant, options.currentCrypto())) {
                    stream.end('desktop device is no longer trusted');
                    return;
                }
                if (frame.type === 'desktop.open' && grant.role === 'view'
                    && frame.params.permissions.some((permission) => permission !== 'view')) {
                    await stream.write(JSON.stringify({ type: 'result', requestId: frame.requestId, ok: false, error: 'this device may only view the desktop', code: 'permission-denied' }) + '\n');
                    return;
                }
                try {
                    const response = await options.answer(frame, deviceId, connectionId);
                    if (!trusted(grant, options.currentCrypto())) {
                        stream.end('desktop device is no longer trusted');
                        return;
                    }
                    if (response !== undefined) await stream.write(JSON.stringify(response) + '\n');
                } catch (error) {
                    const value = error as { code?: unknown };
                    await stream.write(JSON.stringify({
                        type: 'result', requestId: frame.requestId, ok: false,
                        error: error instanceof Error ? error.message : String(error),
                        ...(typeof value.code === 'string' ? { code: value.code } : {}),
                    }) + '\n');
                }
            });
        }
        return work;
    };
    try { await ended; }
    finally { options.onDesktopConnection?.(connectionId, false); }
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
