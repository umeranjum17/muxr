import { sealNotice } from '@byokit/seal';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { Host, PublicLinkError, hostId, keyPairFrom, type Grant, type GrantStore, type LinkRequest, type LinkStream, type PairRequest } from '@byokit/pair';
import { isExpoToken, linkUrl, ownerClient, RelayOwnerError, RelayClient, type RelayClientStore } from '@byokit/relay';
import {
    agentAlertTitle,
    lifecycleNotificationAllowed,
    parseClientFrame,
    parseLifecycleNotificationLevel,
    relayControlUrl,
    type ClientFrame,
    type HostFrame,
    type LifecycleNotificationLevel,
} from '@trymuxr/contract';
import { attachFailureCode, type LinkTerminalAttachParams, type LinkTerminalPort, type TerminalPipe } from '../domain/terminal.js';
import type { MachineCryptoState, MachineDeviceRecord } from '../domain/crypto.js';
import { deviceAuthority } from '../domain/deviceGrant.js';
import { safeQuestion, safeTaskTitle } from '../../platform/safeTaskTitle.js';

/** How the host answers one device's frame: the same answer the relay transport sends back. */
export type LinkAnswer = (frame: ClientFrame, deviceId: string, connectionId?: string) => Promise<HostFrame | undefined>;

/** File-backed RelayClientStore: grant ids whose relay unsubscribe is still
 *  unconfirmed. The kit saves before sending and resends on every connection,
 *  so a host restart between revoke and the relay ack loses nothing. */
export function fileRelayClientStore(path: string): RelayClientStore {
    return {
        load: () => {
            if (!existsSync(path)) return undefined;
            const info = lstatSync(path);
            if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
                throw new Error('link revoked-devices store must be an owner-only regular file');
            }
            const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
            if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
                throw new Error('link revoked-devices store is malformed');
            }
            return parsed;
        },
        save: (devices) => {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            const temporary = `${path}.tmp-${process.pid}`;
            writeFileSync(temporary, `${JSON.stringify(devices)}\n`, { mode: 0o600 });
            chmodSync(temporary, 0o600);
            renameSync(temporary, path);
        },
    };
}

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
    /** Pending relay unsubscribes, persisted so they survive a host restart.
     *  Omit it and the kit keeps them in memory only. */
    revokeStore?: RelayClientStore;
    answer: LinkAnswer;
    canView: (frame: ClientFrame) => boolean;
    /** Given, a control or observing device may carry a terminal pane over a link stream. */
    terminals?: LinkTerminalPort;
    voiceStreams?: { attach(params: { deviceId: string; channel: string; sessionId?: string; stream: LinkStream }): Promise<void> };
    onStatus?: (status: string) => void;
    onDesktopConnection?: (connectionId: string, active: boolean) => void;
    /** Given, a device may carry its desktop session's loopback ICE-over-TCP port over a `desktop.tcp` stream. */
    desktopTcp?: (desktopId: string, port: number, deviceId: string) => boolean;
    onDeviceConnection?: (deviceId: string, active: boolean) => void;
    onDeviceRevoked?: (deviceId: string, removed: boolean) => void | Promise<void>;
}

interface DeviceMeta { muxrDeviceId: string }

/** The relay's cap on a push's data, which carries the sealed notice. */
const SEALED_NOTICE_MAX = 2048;

/** Kept in step with the relay's push builder — same copy for both transports. */
const COPY_SUFFIX: Record<string, string> = {
    blocked: ' needs attention.',
    done: ' finished.',
    failed: ' failed.',
};

export interface GeneralNoticeInput {
    title: string;
    body: string;
    url?: string;
    id: string;
    machineId: string;
}

/** The sealed body of a general notification; the envelope shape the app opens. */
export function generalNoticeEnvelope(input: GeneralNoticeInput): {
    title: string;
    body: string;
    data: Record<string, unknown>;
} {
    return {
        title: input.title,
        body: input.body,
        data: {
            eventId: input.id,
            kind: 'notify',
            machineId: input.machineId,
            presentationOwner: 'relay-push',
            ...(input.url === undefined ? {} : { url: input.url }),
        },
    };
}

/**
 * The link role a stored device is enrolled and trusted under. It reads the
 * domain's authority, so a browser record stored without one stays view-only.
 * Peers keep the control role here; the dispatcher scopes them by capability.
 */
const linkRole = (device: MachineDeviceRecord): Grant['role'] =>
    device.kind !== 'peer' && deviceAuthority(device) === 'observe' ? 'view' : 'control';

const VIEW_ONLY_REFUSAL = 'this device grant is view-only; pair a control browser or use the native app';

/**
 * What a device may send: a control grant anything, a view grant only what
 * the host lets a watcher read (deny by default), plus its own push
 * registration. Request frames and desktop signaling both pass here, because
 * the desktop engine applies input from any session it opens.
 */
function permits(grant: Grant, frame: ClientFrame, canView: LinkEndpointOptions['canView']): boolean {
    return grant.role === 'control' || frame.type.startsWith('push.') || canView(frame);
}

const deniedNoted = new Set<string>();
/** One line per device and input kind, never the payload. */
function noteDenied(grant: Grant, kind: 'request' | 'desktop' | 'terminal'): void {
    const key = `${grant.id} ${kind}`;
    if (deniedNoted.has(key)) return;
    deniedNoted.add(key);
    process.stderr.write(`link: dropped ${kind} input from view-only device ${muxrDeviceIdOf(grant) ?? grant.id}\n`);
}

const muxrDeviceIdOf = (grant: Grant): string | undefined => {
    const meta = grant.meta as Partial<DeviceMeta> | undefined;
    return typeof meta?.muxrDeviceId === 'string' ? meta.muxrDeviceId : undefined;
};

// MUXR_PAIR_CODE_MS is a test knob: only the cross-side expiry journey shortens the code with it.
const pairCodeMs = (): number => {
    const override = Number(process.env.MUXR_PAIR_CODE_MS);
    return Number.isSafeInteger(override) && override > 0 && override <= 2_147_483_647 ? override : 120_000;
};

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

    constructor(private readonly stream: LinkStream, private readonly observe: boolean, onDropped?: () => void) {
        stream.onData = (chunk) => {
            if (this.observe) onDropped?.();
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

    send(line: string): Promise<void> {
        // The link is a byte stream, not messages: every line carries its own newline.
        return this.stream.write(`${line}\n`).catch((error: unknown) => {
            this.finish();
            throw error;
        });
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
    return crypto.devices.filter((device) => (device.kind === undefined || device.kind === 'browser' || device.kind === 'peer')
        && device.deviceId !== crypto.pendingRotation?.revokedDeviceId && Date.parse(device.expiresAt) > now);
}

function trusted(grant: Grant, crypto: MachineCryptoState | undefined): boolean {
    if (crypto === undefined) return false;
    const deviceId = muxrDeviceIdOf(grant);
    const device = linkDevices(crypto, Date.now()).find((entry) => entry.deviceId === deviceId);
    const result = device !== undefined && Buffer.from(device.devicePublicKey, 'base64').toString('base64url') === grant.key
        && linkRole(device) === grant.role;
    return result;
}

/**
 * The machine on @byokit/pair, beside the relay transport. It proves the
 * machine's existing box key to the relay and enrols native phones under
 * their existing keys, so a future link client can reuse its pairing.
 *
 * `selfhost.json` stays the only authority. Grants are reconciled on changes,
 * while admission, replies and broadcasts check the live device table so a
 * revoked device cannot use a stale grant before reconciliation.
 */
export class LinkEndpoint {
    private synced: Promise<boolean> = Promise.resolve(true);
    private pairing: { kind: 'native' | 'browser'; confirm: (request: PairRequest, options: { signal: AbortSignal }) => boolean | Promise<boolean>; handle: (request: LinkRequest, grant: Grant) => Promise<unknown> } | undefined;

    private client?: RelayClient;
    private connectionTimer?: ReturnType<typeof setInterval>;
    private readonly deviceConnections = new Map<string, boolean>();

    private constructor(private readonly host: Host,
        private readonly currentCrypto: () => MachineCryptoState | undefined,
        private readonly savePushLevel: LinkEndpointOptions['savePushLevel'],
        private readonly connectRelay: () => RelayClient,
        private readonly machineId?: string,
        private readonly onDeviceConnection?: (deviceId: string, active: boolean) => void,
        private readonly onDeviceRevoked?: (deviceId: string, removed: boolean) => void | Promise<void>) {}

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
                if (req.op === 'terminal') return streamTerminal(stream, req, grant, options);
                if (req.op === 'desktop') return streamDesktop(stream, req, grant, options);
                if (req.op === 'desktop.tcp') return streamDesktopTcp(stream, req, grant, options);
                throw new PublicLinkError('unsupported link stream');
            },
            keys,
            name: options.machineName,
            pairMs: pairCodeMs(),
            grants: options.grants,
            confirm: (request, { signal }) => endpoint?.pairing?.confirm(request, { signal }) ?? false,
            allow: (req, grant) => {
                if (req.op === 'pair.complete' || req.op === 'pair.verified') return endpoint?.pairing !== undefined && grant.kind === endpoint.pairing.kind;
                if (req.op === 'terminal') return options.terminals !== undefined;
                if (!trusted(grant, options.currentCrypto())) return false;
                if (req.op === 'voice') return grant.role === 'control' && options.voiceStreams !== undefined;
                if (req.op === 'desktop' || req.op === 'desktop.tcp') return true;
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op || frame.type.startsWith('desktop.')) return false;
                if (permits(grant, frame, options.canView)) return true;
                noteDenied(grant, 'request');
                return false;
            },
            handle: async (req, grant) => {
                if (req.op === 'pair.complete' || req.op === 'pair.verified') {
                    if (endpoint.pairing === undefined || grant.kind !== endpoint.pairing.kind) throw new Error('link: pairing is closed');
                    return endpoint.pairing.handle(req, grant);
                }
                if (!trusted(grant, options.currentCrypto())) throw new Error('link: device no longer trusted');
                const deviceId = muxrDeviceIdOf(grant)!;
                const frame = parseClientFrame(req.args);
                if (frame.type !== req.op) throw new Error('link: request op does not match its frame');
                if (frame.type.startsWith('push.')) return endpoint.pushRequest(frame, grant, deviceId);
                if (frame.type.startsWith('desktop.')) throw new PublicLinkError('Desktop signaling must use a link stream.');
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
            ...(options.revokeStore === undefined ? {} : { store: options.revokeStore }),
        }), options.machineId, options.onDeviceConnection, options.onDeviceRevoked);
        if (!await endpoint.sync(options.crypto)) {
            endpoint.close();
            throw new Error('link: initial device sync failed');
        }
        return endpoint;
    }

    start(): void {
        this.client = this.connectRelay();
        // Removals found before the relay client existed waited for it.
        const crypto = this.currentCrypto();
        if (crypto !== undefined) void this.sync(crypto);
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
        question?: string;
    }): void {
        if (input.agentName === undefined || this.client === undefined) return;
        const crypto = this.currentCrypto();
        const recipients = this.host.devices().filter((grant) => {
            if (!trusted(grant, crypto)) return false;
            const device = crypto?.devices.find((entry) => entry.deviceId === muxrDeviceIdOf(grant));
            return device?.pushLevel !== undefined && lifecycleNotificationAllowed(device.pushLevel, input.kind);
        });
        if (recipients.length === 0) return;
        const taskTitle = safeTaskTitle(input.taskTitle);
        const title = agentAlertTitle({ taskTitle, agentName: input.agentName });
        const suffix = input.kind === 'failed' && COPY_SUFFIX.failed !== undefined && input.reasonCode !== undefined
            && ['start-launch-failed', 'start-timeout', 'squad-rolled-back', 'agent-unavailable'].includes(input.reasonCode)
            ? ' could not start.'
            : COPY_SUFFIX[input.kind];
        const question = input.kind === 'blocked' ? safeQuestion(input.question) : undefined;
        const notice = (asked: string | undefined) => ({
            title,
            // A blocked agent's own question is the alert; the sealed notice keeps it from the relay.
            body: asked ?? `${input.agentName}${suffix}`,
            data: {
                eventId: input.eventId,
                kind: input.kind,
                reasonCode: input.reasonCode,
                agentName: input.agentName,
                ...(taskTitle === undefined ? {} : { taskTitle }),
                sessionId: input.sessionId,
                machineId: input.machineId,
                presentationOwner: 'relay-push',
            },
        });
        for (const grant of recipients) {
            const key = Buffer.from(grant.key, 'base64url');
            let sealed = sealNotice(notice(question), key);
            // The relay refuses push data over 2 KB; a wide question gives way to the plain copy.
            if (JSON.stringify(sealed).length > SEALED_NOTICE_MAX) sealed = sealNotice(notice(undefined), key);
            void this.client.notify({
                id: createHash('sha256').update(JSON.stringify([input.eventId, grant.id])).digest('hex'),
                title: 'Agent update',
                body: 'An agent has an update.',
                data: sealed,
                to: [grant.id],
                urgency: input.kind === 'blocked' ? 'high' : 'normal',
            }, { includeContent: true }).catch((cause: unknown) => {
                process.stderr.write(`link: push notify failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            });
        }
    }

    /**
     * Fan one general notification out to every trusted link device on the
     * same relay push path as lifecycle notices. The relay and push provider
     * see only generic text and ciphertext; title, body and link stay inside
     * the seal. Returns the number of paired devices fanned out to.
     */
    notifyGeneral(input: GeneralNoticeInput): number {
        if (this.client === undefined) return 0;
        const crypto = this.currentCrypto();
        const recipients = this.host.devices().filter((grant) => {
            if (!trusted(grant, crypto)) return false;
            // Only a device that registered for push has a relay address, and general
            // notices follow the device's level: 'off' and 'important' skip them.
            const device = crypto?.devices.find((entry) => entry.deviceId === muxrDeviceIdOf(grant));
            return device?.pushLevel === 'all';
        });
        if (recipients.length === 0) return 0;
        const notice = (url: string | undefined) => generalNoticeEnvelope(
            url === undefined ? { title: input.title, body: input.body, id: input.id, machineId: input.machineId } : { ...input, url });
        for (const grant of recipients) {
            const key = Buffer.from(grant.key, 'base64url');
            let sealed = sealNotice(notice(input.url), key);
            // The relay refuses push data over 2 KB; a long link gives way.
            if (JSON.stringify(sealed).length > SEALED_NOTICE_MAX) sealed = sealNotice(notice(undefined), key);
            void this.client.notify({
                id: createHash('sha256').update(JSON.stringify([input.id, grant.id])).digest('hex'),
                title: 'muxr',
                body: 'You have a new notification.',
                data: sealed,
                to: [grant.id],
                urgency: 'normal',
            }, { includeContent: true }).catch((cause: unknown) => {
                process.stderr.write(`link: push notify failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            });
        }
        return recipients.length;
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

    /** Open the one-time offer on this machine's already-registered host. */
    offerPairing(pairing: NonNullable<LinkEndpoint['pairing']>, relayUrl: string, intent: { kind: 'native' | 'browser'; authority: 'control' | 'observe'; lifetime?: number; base?: string }): { text: string; expires: number; pairMs: number; compactText?: string; compactExpires?: number } {
        if (this.pairing !== undefined && this.pairing !== pairing) throw new Error('another pairing is in progress');
        this.pairing = pairing;
        const urls = [linkUrl(relayUrl, this.host.id)];
        const role = intent.authority === 'observe' ? 'view' : 'control';
        const offer = this.host.offer({ urls, role, kind: intent.kind,
            ...(intent.lifetime === undefined ? {} : { lifetime: intent.lifetime }), ...(intent.base === undefined ? {} : { base: intent.base }) });
        // Native phones read either text. The terminal shows the full v1 offer
        // wherever its QR fits and the compact offer where it cannot; the
        // compact form packs the same addresses and terms through one code
        // entry, so its phone pairs like a typed code. Either offer keeps a
        // pending grant: the phone holds the host key the code handshake
        // authenticated (v1 carries it, the compact offer gets it from
        // onPending), so a phone killed before approving reconnects only to
        // this computer. Browser links keep the full offer: the compact form
        // has no browser-link shape.
        const pairMs = pairCodeMs();
        if (intent.kind !== 'native') return { ...offer, pairMs };
        try {
            const compact = this.host.compactOffer({ urls, role, kind: intent.kind,
                ...(intent.lifetime === undefined ? {} : { lifetime: intent.lifetime }) });
            return { ...offer, pairMs, compactText: compact.text, compactExpires: compact.expires };
        } catch (error) {
            process.stderr.write(`muxr: compact pairing offer unavailable, showing the full offer: ${error instanceof Error ? error.message : String(error)}\n`);
            return { ...offer, pairMs };
        }
    }

    stopPairing(): void {
        this.pairing = undefined;
        this.host.stopPairing();
        const crypto = this.currentCrypto();
        if (crypto !== undefined) void this.sync(crypto);
    }

    async admitPairedDevice(grantId: string, deviceId: string): Promise<void> {
        await this.host.setMeta(grantId, { muxrDeviceId: deviceId } satisfies DeviceMeta);
    }

    async rejectPairedDevice(grantId: string): Promise<void> {
        await this.revoke(grantId);
    }

    /** Removes a device: the link grant now, and through RelayClient.revoke its
     *  push subscriptions on the relay. That relay half queues while the relay is
     *  offline, so removal, teardown and pairing rollback never wait on it; the
     *  local grant is gone first, which makes the kit's own link revoke a no-op. */
    private async revoke(grantId: string): Promise<void> {
        await this.host.revoke(grantId);
        this.client?.revoke(grantId).catch((error: unknown) => {
            process.stderr.write(`link: relay unsubscribe failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
    }

    broadcast(frame: HostFrame, deviceId?: string): void {
        const crypto = this.currentCrypto();
        this.host.broadcast(frame, (grant) => trusted(grant, crypto)
            && (deviceId === undefined || muxrDeviceIdOf(grant) === deviceId));
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
            // Approval creates a provisional link grant before pair.complete
            // writes its durable device record. A slow remote reconnect must
            // not be revoked by the host's two-second record reconciliation.
            if (deviceId === undefined && this.pairing !== undefined) continue;
            const device = deviceId === undefined ? undefined : wanted.get(deviceId);
            const sameKey = device !== undefined && Buffer.from(device.devicePublicKey, 'base64').toString('base64url') === grant.key;
            const roleMatches = device !== undefined && linkRole(device) === grant.role;
            // A role-only change keeps the pairing: the phone reconnects under
            // the new grant without being told it was removed.
            if (device === undefined || !sameKey) {
                // A removal also drops the device's push subscriptions on the
                // relay, so it waits for start(): no device reaches this host
                // before the relay client dials, and trusted() already refuses it.
                if (this.client === undefined) continue;
                await this.revoke(grant.id);
                if (deviceId !== undefined) {
                    this.deviceConnections.delete(deviceId);
                    this.onDeviceConnection?.(deviceId, false);
                    await this.onDeviceRevoked?.(deviceId, true);
                }
            } else if (roleMatches) enrolled.add(device.deviceId);
            else if (deviceId !== undefined) await this.onDeviceRevoked?.(deviceId, false);
        }
        for (const device of wanted.values()) {
            if (enrolled.has(device.deviceId)) continue;
            await this.host.enrol({
                key: Buffer.from(device.devicePublicKey, 'base64'),
                name: device.name ?? 'Paired phone',
                role: linkRole(device),
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
    // The Computer request path in the host log: every open, answer and close,
    // and the first failing poll or candidate of each desktop, so a stalled
    // phone shows how far its request got. Never SDP, candidates or grants.
    const quietFailures = new Set<string>();
    const note = (frame: ClientFrame & { requestId: string }, started: number, failure?: string): void => {
        const loud = frame.type === 'desktop.open' || frame.type === 'desktop.answer' || frame.type === 'desktop.close';
        const desktopId = (frame as { params?: { desktopId?: unknown } }).params?.desktopId;
        const key = `${frame.type} ${typeof desktopId === 'string' ? desktopId : ''}`;
        if (!loud && (failure === undefined || quietFailures.has(key))) return;
        if (!loud) quietFailures.add(key);
        process.stderr.write(`link: ${frame.type}${typeof desktopId === 'string' ? ` ${desktopId}` : ''} from device ${deviceId} ${failure === undefined ? 'ok' : `failed (${failure})`} in ${Date.now() - started} ms\n`);
    };
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
                if (!permits(grant, frame, options.canView)) {
                    noteDenied(grant, 'desktop');
                    note(frame, Date.now(), 'permission-denied');
                    await stream.write(JSON.stringify({ type: 'result', requestId: frame.requestId, ok: false, error: VIEW_ONLY_REFUSAL, code: 'permission-denied' }) + '\n');
                    return;
                }
                const started = Date.now();
                try {
                    const response = await options.answer(frame, deviceId, connectionId);
                    const refused = response as { ok?: unknown; code?: unknown } | undefined;
                    note(frame, started, refused?.ok === false ? String(refused.code ?? 'refused') : undefined);
                    if (!trusted(grant, options.currentCrypto())) {
                        stream.end('desktop device is no longer trusted');
                        return;
                    }
                    if (response !== undefined) await stream.write(JSON.stringify(response) + '\n');
                } catch (error) {
                    const value = error as { code?: unknown };
                    note(frame, started, typeof value.code === 'string' ? value.code : 'error');
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
 * One ICE-over-TCP connection from the phone to the desktop engine: the stream
 * is the socket, bytes both ways, so a phone that reaches this computer only
 * through the relay still gets the picture. The bytes stay DTLS inside Noise.
 * Only a loopback port the device's own session announced is dialled.
 */
async function streamDesktopTcp(stream: LinkStream, req: LinkRequest, grant: Grant, options: LinkEndpointOptions): Promise<void> {
    const args = req.args as { desktopId?: unknown; port?: unknown } | null;
    if (!trusted(grant, options.currentCrypto()) || grant.role !== 'control' || args === null || typeof args !== 'object'
        || typeof args.desktopId !== 'string' || typeof args.port !== 'number'
        || options.desktopTcp?.(args.desktopId, args.port, muxrDeviceIdOf(grant)!) !== true) {
        throw new PublicLinkError('desktop: that connection is not open to this device');
    }
    const socket = connect({ host: '127.0.0.1', port: args.port });
    process.stderr.write('link: desktop picture carried over the link\n');
    let carried = 0;
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => { finish = resolve; });
    socket.on('close', () => {
        process.stderr.write(`link: desktop link connection closed after ${carried} bytes to the phone\n`);
        finish();
    });
    socket.on('data', (chunk) => {
        carried += chunk.length;
        socket.pause();
        stream.write(chunk).then(() => socket.resume(), () => socket.destroy());
    });
    socket.on('end', () => stream.end());
    socket.on('error', (error) => stream.end(`desktop: ${error.message}`));
    stream.onData = (chunk) => new Promise<void>((resolve) => {
        if (socket.write(chunk)) { resolve(); return; }
        const settle = (): void => { socket.off('drain', settle); socket.off('close', settle); resolve(); };
        socket.on('drain', settle);
        socket.on('close', settle);
    });
    stream.onEnd = () => { socket.destroy(); };
    await closed;
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

/**
 * The device's terminal pane over a link stream: the stream open IS the attach.
 * The first line back is the same `result` shape a terminal.attach request gets
 * (ok with the pane, or the attach error with its code, e.g. `takeover`), then
 * herdr's NDJSON flows both ways until the stream ends.
 */
async function streamTerminal(stream: LinkStream, req: LinkRequest, grant: Grant, options: LinkEndpointOptions): Promise<void> {
    const params = parseLinkTerminalAttach(req.args);
    if (params === undefined) throw new PublicLinkError('terminal: malformed attach');
    const deviceId = muxrDeviceIdOf(grant)!;
    // An observing device renders the pane without touching it, the same way
    // the relay dispatcher rewrites its terminal.attach.
    const mode = grant.role === 'view' ? 'observe' : params.mode;
    const socket: TerminalPipe = new LinkTerminalSocket(stream, mode === 'observe',
        grant.role === 'view' ? () => noteDenied(grant, 'terminal') : undefined);
    const reply = (result: { ok: true; data: { paneId: string } } | { ok: false; error: string; code?: string }): void => {
        options.terminals!.sendResult(socket, params.channel, { type: 'result', requestId: params.requestId, ...result });
    };
    try {
        const assertAuthorized = (): void => {
            if (!trusted(grant, options.currentCrypto())) throw Object.assign(new Error('terminal: device is no longer trusted'), { code: 'device-revoked' });
        };
        assertAuthorized();
        const { paneId } = await options.terminals!.attach({ ...params, deviceId, socket, assertAuthorized,
            ...(mode === undefined ? {} : { mode }) });
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
    const owner = ownerClient(relayControlUrl(relayUrl), ownerToken, {
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
    });
    let hosts;
    try { hosts = await owner.hosts(); }
    catch (cause) {
        if (cause instanceof RelayOwnerError && (cause.status === 403 || cause.status === 404)) return false;
        throw cause;
    }
    if (hosts.some((host) => host.id === id)) return undefined;
    return (await owner.enrolment({ name })).token;
}
