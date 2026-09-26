import { randomUUID } from 'node:crypto';
import { Host, PublicLinkError, hostId, keyPairFrom, type Grant, type GrantStore, type LinkRequest, type LinkStream } from '@byokit/link';
import { isExpoToken, RelayClient } from '@byokit/relay';
import {
    lifecycleNotificationAllowed, parseClientFrame, parseLifecycleNotificationLevel, relayControlUrl,
    type ClientFrame, type HostFrame, type LifecycleNotificationLevel,
} from '@muxr/contract';
import { attachFailureCode, type LinkTerminalAttachParams, type LinkTerminalPort, type TerminalPipe } from '../domain/terminal.js';
import type { MachineCryptoState, MachineDeviceRecord } from '../domain/crypto.js';

/** How the host answers one device's frame: the same answer the relay transport sends back. */
export type LinkAnswer = (frame: ClientFrame, deviceId: string, connectionId?: string) => Promise<HostFrame | undefined>;

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
    savePushLevel: (deviceId: string, level: LifecycleNotificationLevel | undefined) => void;
    grants: GrantStore;
    answer: LinkAnswer;
    canView: (frame: ClientFrame) => boolean;
    /** Given, a control or observing device may carry a terminal pane over a link stream. */
    terminals?: LinkTerminalPort;
    voiceStreams?: { attach(params: { deviceId: string; channel: string; sessionId?: string; stream: LinkStream }): Promise<void> };
    pluginStreams?: { attach(params: { deviceId: string; pluginId: string; manifestHash: string; contributionId: string; channel: string; sessionId?: string; stream: LinkStream }): Promise<void> };
    onStatus?: (status: string) => void;
    onDesktopConnection?: (connectionId: string, active: boolean) => void;
    onDeviceConnection?: (deviceId: string, active: boolean) => void;
    onDeviceRevoked?: (deviceId: string) => void | Promise<void>;
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

/** Full attach call for the port: the validated stream args plus who is asking. */
type LinkTerminalAttach = LinkTerminalAttachParams & { deviceId: string; socket: TerminalPipe; assertAuthorized: () => void };

/** Link stream args for a terminal pane, as the device opens the stream with them. */
type LinkTerminalWireAttach = {
    requestId: string;
    sessionId: string;
    channel: string;
    cols: number;
    rows: number;
    mode?: 'control' | 'observe';
    takeover?: boolean;
};

const CHANNEL_PATTERN = /^tm_[A-Za-z0-9]+_[A-Za-z0-9]+$/;

/** Everything on a link stream is network input; validate before the pane machinery sees it. */
function parseLinkTerminalAttach(args: unknown): LinkTerminalWireAttach | undefined {
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
            if (this.buffer.length > 1_048_576) { this.close(); return; }
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
        if (this.ended) listener();
        else this.ends.add(listener);
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

/** Admit native and browser grants only while the durable device record trusts them. */
function linkDevices(crypto: MachineCryptoState, now: number): MachineDeviceRecord[] {
    return crypto.devices.filter((device) => (device.kind === undefined || device.kind === 'browser')
        && device.deviceId !== crypto.pendingRotation?.revokedDeviceId && Date.parse(device.expiresAt) > now);
}

function trusted(grant: Grant, crypto: MachineCryptoState | undefined): boolean {
    if (crypto === undefined) return false;
    const deviceId = muxrDeviceIdOf(grant);
    const device = linkDevices(crypto, Date.now()).find((entry) => entry.deviceId === deviceId);
    const result = device !== undefined && Buffer.from(device.devicePublicKey, 'base64').toString('base64url') === grant.key
        && (device.authority === 'observe' ? 'view' : 'control') === grant.role;
    return result;
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
        private readonly savePushLevel: LinkEndpointOptions['savePushLevel'],
        private readonly connectRelay: () => RelayClient,
        private readonly machineId?: string,
        private readonly onDeviceConnection?: (deviceId: string, active: boolean) => void,
        private readonly onDeviceRevoked?: (deviceId: string) => void | Promise<void>) {}

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
        let endpoint: LinkEndpoint;
        const host = await Host.open({
            stream: (stream: LinkStream, req: LinkRequest, grant: Grant) => {
                if (req.op === 'voice') return streamVoice(stream, req, grant, options);
                if (req.op === 'plugin') return streamPlugin(stream, req, grant, options);
                if (req.op === 'terminal') return streamTerminal(stream, req, grant, options);
                if (req.op === 'desktop') return streamDesktop(stream, req, grant, options);
                throw new PublicLinkError('unsupported link stream');
            },
            keys,
            name: options.machineName,
            grants: options.grants,
            // Pairing stays on the relay transport; the link only admits phones
            // enrolled from this machine's own device records.
            confirm: () => false,
            allow: (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) return false;
                if (req.op === 'terminal' || req.op === 'desktop') return true;
                if (req.op === 'voice') return grant.role === 'control' && options.voiceStreams !== undefined;
                if (req.op === 'plugin') return grant.role === 'control' && options.pluginStreams !== undefined;
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op || frame.type.startsWith('desktop.')) return false;
                return frame.type.startsWith('push.') || grant.role === 'control' || options.canView(frame);
            },
            handle: async (req, grant) => {
                if (!trusted(grant, options.currentCrypto())) throw new Error('link: device no longer trusted');
                const deviceId = muxrDeviceIdOf(grant)!;
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op) throw new Error('link: request op does not match its frame');
                if (frame.type.startsWith('push.')) return endpoint.pushRequest(frame, grant, deviceId);
                if (frame.type.startsWith('desktop.')) {
                    throw new PublicLinkError('Remote desktop is not available over this link yet.');
                }
                const response = await options.answer(frame, deviceId);
                if (!trusted(grant, options.currentCrypto())) throw new Error('link: device no longer trusted');
                return response;
            },
        });
        endpoint = new LinkEndpoint(host, options.currentCrypto, options.savePushLevel, () => new RelayClient(host, {
            url: new URL('/relay/v1/host', relayControlUrl(options.relayUrl)).toString().replace(/^http/, 'ws'),
            name: options.machineName,
            ...(enrol === undefined ? {} : { enrol }),
            ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
        }), options.machineId, options.onDeviceConnection, options.onDeviceRevoked);
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
        const crypto = this.currentCrypto();
        const to = this.host.devices().filter((grant) => {
            if (!trusted(grant, crypto)) return false;
            const device = crypto?.devices.find((entry) => entry.deviceId === muxrDeviceIdOf(grant));
            return device?.pushLevel !== undefined && lifecycleNotificationAllowed(device.pushLevel, input.kind);
        }).map((grant) => grant.id);
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

    private async pushRequest(frame: ClientFrame, grant: Grant, deviceId: string): Promise<HostFrame> {
        if (!frame.type.startsWith('push.')) throw new Error('link: not a push request');
        if (this.client === undefined) throw new PublicLinkError('push needs the relay connection; retry when it is online');
        if (frame.type === 'push.vapid') {
            const publicKey = this.client.vapidKey;
            if (publicKey === undefined) throw new PublicLinkError('push key unavailable; retry when the relay is online');
            return { type: 'result', requestId: frame.requestId, ok: true, data: { publicKey } };
        }
        if (frame.type === 'push.unsubscribe') {
            await this.client.unsubscribe(grant.id);
            this.savePushLevel(deviceId, undefined);
            return { type: 'result', requestId: frame.requestId, ok: true, data: null };
        }
        if (frame.type !== 'push.subscribe') throw new PublicLinkError('unknown push request');
        const { token, subscription } = frame.params;
        if (token !== undefined && !isExpoToken(token) || (token === undefined) === (subscription === undefined)) {
            throw new PublicLinkError('push.subscribe needs one push address');
        }
        const level = frame.params.level === undefined ? 'important' : parseLifecycleNotificationLevel(frame.params.level);
        if (level === undefined) throw new PublicLinkError('push.subscribe level is invalid');
        await this.client.subscribe(grant.id, token !== undefined ? { expo: token } : { web: subscription! });
        this.savePushLevel(deviceId, level);
        return { type: 'result', requestId: frame.requestId, ok: true, data: null };
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
                if (this.client !== undefined) await this.client.revoke(grant.id);
                else await this.host.revoke(grant.id);
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
                name: device.name ?? 'Paired phone',
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
 * The device's terminal pane over a link stream: the stream open IS the attach.
 * The first line back is the same `result` shape a terminal.attach request gets
 * (ok with the pane, or the attach error with its code, e.g. `takeover`), then
 * herdr's NDJSON flows both ways until the stream ends.
 */
async function streamPlugin(stream: LinkStream, req: LinkRequest, grant: Grant, options: LinkEndpointOptions): Promise<void> {
    if (!trusted(grant, options.currentCrypto()) || grant.role !== 'control' || options.pluginStreams === undefined) {
        throw new PublicLinkError('plugin: device is no longer trusted');
    }
    const args = req.args as Record<string, unknown> | null;
    if (args === null || typeof args !== 'object'
        || typeof args.channel !== 'string' || !/^rs_[A-Za-z0-9_-]{8,80}$/.test(args.channel)
        || !['pluginId', 'manifestHash', 'contributionId'].every((key) => typeof args[key] === 'string' && (args[key] as string).length > 0 && (args[key] as string).length <= 200)
        || (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || args.sessionId.length === 0 || args.sessionId.length > 200))) {
        throw new PublicLinkError('plugin: malformed stream');
    }
    await options.pluginStreams.attach({
        deviceId: muxrDeviceIdOf(grant)!,
        pluginId: args.pluginId as string,
        manifestHash: args.manifestHash as string,
        contributionId: args.contributionId as string,
        channel: args.channel,
        ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
        stream,
    });
}

async function streamVoice(stream: LinkStream, req: LinkRequest, grant: Grant, options: LinkEndpointOptions): Promise<void> {
    const args = req.args as { channel?: unknown; sessionId?: unknown } | null;
    if (!trusted(grant, options.currentCrypto())) throw new PublicLinkError('voice: device is no longer trusted');
    if (grant.role !== 'control' || options.voiceStreams === undefined || args === null || typeof args !== 'object'
        || typeof args.channel !== 'string' || !/^rs_[A-Za-z0-9_-]{8,80}$/.test(args.channel)
        || (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || args.sessionId.length === 0 || args.sessionId.length > 200))) {
        throw new PublicLinkError('voice: malformed or unauthorized stream');
    }
    await options.voiceStreams.attach({
        deviceId: muxrDeviceIdOf(grant)!,
        channel: args.channel,
        ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
        stream,
    });
}

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
        options.terminals!.sendResult(socket, params.channel, { type: 'result', requestId: params.requestId, ...result });
    };
    try {
        const assertAuthorized = (): void => {
            if (!trusted(grant, options.currentCrypto())) throw Object.assign(new Error('terminal: device is no longer trusted'), { code: 'device-revoked' });
        };
        const attach: LinkTerminalAttach = { ...params, deviceId, socket, assertAuthorized, ...(mode === undefined ? {} : { mode }) };
        const { paneId } = await options.terminals!.attach(attach);
        assertAuthorized();
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
