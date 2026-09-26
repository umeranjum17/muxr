import { Host, PublicLinkError, hostId, keyPairFrom, type Grant, type LinkRequest, type LinkStream } from '@byokit/link';
import { RelayClient } from '@byokit/relay';
import { parseClientFrame, relayControlUrl, type ClientFrame, type HostFrame } from '@muxr/contract';
import { attachFailureCode, type LinkTerminalAttachParams, type LinkTerminalPort, type TerminalPipe } from '../domain/terminal.js';
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
    /** Given, a control or observing device may carry a terminal pane over a link stream. */
    terminals?: LinkTerminalPort;
    onStatus?: (status: string) => void;
}

interface DeviceMeta { muxrDeviceId: string }

const muxrDeviceIdOf = (grant: Grant): string | undefined => {
    const meta = grant.meta as Partial<DeviceMeta> | undefined;
    return typeof meta?.muxrDeviceId === 'string' ? meta.muxrDeviceId : undefined;
};

/** Full attach call for the port: the validated stream args plus who is asking. */
type LinkTerminalAttach = LinkTerminalAttachParams & { deviceId: string; socket: TerminalPipe };

const CHANNEL_PATTERN = /^tm_[A-Za-z0-9]+_[A-Za-z0-9]+$/;

/** Everything on a link stream is network input; validate before the pane machinery sees it. */
function parseLinkTerminalAttach(args: unknown): LinkTerminalAttachParams | undefined {
    if (typeof args !== 'object' || args === null) return undefined;
    const a = args as Record<string, unknown>;
    if (typeof a.requestId !== 'string' || a.requestId.length === 0 || a.requestId.length > 80) return undefined;
    if (typeof a.sessionId !== 'string' || a.sessionId.length === 0 || a.sessionId.length > 200) return undefined;
    if (typeof a.channel !== 'string' || !CHANNEL_PATTERN.test(a.channel)) return undefined;
    if (!Number.isInteger(a.cols) || (a.cols as number) < 1 || (a.cols as number) > 500) return undefined;
    if (!Number.isInteger(a.rows) || (a.rows as number) < 1 || (a.rows as number) > 500) return undefined;
    if (a.mode !== undefined && a.mode !== 'control' && a.mode !== 'observe') return undefined;
    if (a.takeover !== undefined && typeof a.takeover !== 'boolean') return undefined;
    return {
        requestId: a.requestId,
        sessionId: a.sessionId,
        channel: a.channel,
        cols: a.cols as number,
        rows: a.rows as number,
        ...(a.mode === undefined ? {} : { mode: a.mode }),
        ...(a.takeover === undefined ? {} : { takeover: a.takeover }),
    };
}

/**
 * A byokit link stream as a terminal socket: NDJSON lines each way, whole
 * lines out of `onLine`. Frames are exactly what the relay channel carries --
 * the Noise channel is the encryption there, and a hosted machine's sealed
 * envelopes pass through untouched so the terminal manager sees no difference.
 */
class LinkTerminalSocket implements TerminalPipe {
    private readonly lines = new Set<(line: string) => void>();
    private readonly ends = new Set<() => void>();
    private readonly decoder = new TextDecoder();
    /** Input lines that arrived before the pane machinery listened, flushed on the first onLine. */
    private readonly early: string[] = [];
    private earlySize = 0;
    private buffer = '';
    private ended = false;

    constructor(private readonly stream: LinkStream, private readonly observe: boolean) {
        stream.onData = (chunk) => {
            if (this.ended || this.observe) return;
            this.buffer += this.decoder.decode(chunk, { stream: true });
            if (this.buffer.length > 1_048_576) {
                this.close();
                return;
            }
            const lines = this.buffer.split('\n');
            this.buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (this.ended) break;
                this.deliver(line);
            }
        };
        stream.onEnd = () => this.finish();
    }

    get isOpen(): boolean {
        return !this.ended;
    }

    send(line: string): void {
        // The link is a byte stream, not messages: every line carries its own newline.
        this.stream.write(`${line}\n`).then(() => undefined, () => this.finish());
    }

    onLine(listener: (line: string) => void): () => void {
        this.lines.add(listener);
        if (this.early.length > 0) {
            for (const line of this.early.splice(0)) listener(line);
            this.earlySize = 0;
        }
        return () => { this.lines.delete(listener); };
    }

    onEnd(listener: () => void): () => void {
        this.ends.add(listener);
        return () => { this.ends.delete(listener); };
    }

    /** Ends the stream both ways, after the lines already written. */
    close(): void {
        this.stream.end();
        this.finish();
    }

    private deliver(line: string): void {
        if (this.lines.size === 0) {
            this.earlySize += line.length;
            if (this.earlySize > 1_048_576) this.close();
            else this.early.push(line);
            return;
        }
        for (const listener of [...this.lines]) listener(line);
    }

    private finish(): void {
        if (this.ended) return;
        this.ended = true;
        for (const listener of [...this.ends]) listener();
    }
}

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
            ...(options.terminals === undefined ? {} : {
                stream: (stream: LinkStream, req: LinkRequest, grant: Grant) => streamTerminal(stream, req, grant, options),
            }),
            keys,
            name: options.machineName,
            // Pairing stays on the relay transport; the link only admits phones
            // enrolled from this machine's own device records.
            confirm: () => false,
            allow: (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) return false;
                // A terminal stream is admitted for control devices; observing
                // devices are forced to observe mode in the handler below, the
                // same way the relay dispatcher forces it on terminal.attach.
                if (req.op === 'terminal') return true;
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
 * The device's terminal pane over a link stream: the stream open IS the attach.
 * The first line back is the same `result` shape a terminal.attach request gets
 * (ok with the pane, or the attach error with its code, e.g. `takeover`), then
 * herdr's NDJSON flows both ways until the stream ends.
 */
async function streamTerminal(stream: LinkStream, req: LinkRequest, grant: Grant, options: LinkEndpointOptions): Promise<void> {
    const params = parseLinkTerminalAttach(req.args);
    if (params === undefined) throw new PublicLinkError('terminal: malformed attach');
    if (!trusted(grant, options.currentCrypto())) throw new PublicLinkError('terminal: device is no longer trusted');
    const deviceId = muxrDeviceIdOf(grant)!;
    // An observing device renders the pane without touching it, the same way
    // the relay dispatcher rewrites its terminal.attach.
    const mode = grant.role === 'view' ? 'observe' : params.mode;
    const socket: TerminalPipe = new LinkTerminalSocket(stream, mode === 'observe');
    const reply = (result: { ok: true; data: { paneId: string } } | { ok: false; error: string; code?: string }): void => {
        socket.send(JSON.stringify({ type: 'result', requestId: params.requestId, ...result }));
    };
    try {
        const attach: LinkTerminalAttach = { ...params, deviceId, socket, ...(mode === undefined ? {} : { mode }) };
        const { paneId } = await options.terminals!.attach(attach);
        process.stderr.write(`link: terminal stream attached (pane ${paneId}, device ${deviceId}${mode === 'observe' ? ', observe' : ''})\n`);
        reply({ ok: true, data: { paneId } });
    } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error), code: attachFailureCode(error) });
        socket.close();
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
