/**
 * The relay. A pipe.
 *
 * Reads ONLY envelope.header. Never parses envelope.payload.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import {
    RELAY_CLOSE_REPLACED,
    decodePayload,
    encodePayload,
    nextRequestId,
    type Envelope,
    type HostFrame,
} from '@muxr/contract';
import { authenticateWebSocket, extractBearerToken, secureEqual, type PeerIdentity, type Ticket } from './auth.js';
import { OfflineBuffer } from './buffer.js';
import { type RelayConfig, clientIp, loadRelayConfig } from './config.js';
import { handleHttpRequest, readJsonBody, writeJson, type PushActionOutcome } from './httpHandlers.js';
import { PairingRequests } from './pairing.js';
import { parseLastSeq, PeerTable, peerMayRoute, sendEnvelope, type ConnectedPeer } from './peers.js';
import { PreviewChannels } from './preview.js';
import { TerminalChannels } from './terminal.js';
import { PushService } from './push.js';
import { notificationEmailFromEnv } from './email.js';
import { FileTicketStore } from './selfhostTickets.js';
import { SelfhostPairing } from './selfhostPairing.js';
import type { PushWebhookConfig } from './pushWebhook.js';
import { ReplayLog } from './replay.js';
import { MachineRegistry } from './registry.js';
import { awaitPersistChain, writeJsonFileAtomic, readPrivateFile } from './persist.js';
import { deliverReplayAndOffline, routeEnvelope } from './routing.js';

/** How long push/action waits for the machine's answer before giving up. */
const PUSH_ACTION_TIMEOUT_MS = 15_000;

/** Read or create the 0600 mint secret that gates self-host ticket issuance. */
async function ensureMintSecret(dataDir: string): Promise<string> {
    const file = join(dataDir, 'mint-secret');
    const existing = await readPrivateFile(file);
    if (existing !== undefined) {
        try {
            const parsed = JSON.parse(existing) as unknown;
            if (typeof parsed === 'string' && parsed !== '') return parsed;
        } catch {
            // Corrupted or non-JSON file: rotate below.
        }
    }
    const secret = randomBytes(32).toString('base64url');
    await writeJsonFileAtomic(file, secret);
    return secret;
}

/** Secondary hosted hygiene only; endpoint authentication is authoritative. */
function isOpaqueV2Envelope(value: unknown): value is Envelope {
    if (typeof value !== 'object' || value === null) return false;
    const envelope = value as Partial<Envelope>;
    const header = envelope.header;
    return typeof envelope.payload === 'string' && envelope.payload.startsWith('e2ee:v2:')
        && typeof header?.machineId === 'string'
        && typeof header.senderId === 'string'
        && typeof header.recipientId === 'string'
        && (header.channel === 'session' || header.channel === 'terminal' || header.channel === 'attachment' || header.channel === 'stream')
        && typeof header.streamId === 'string'
        && Number.isSafeInteger(header.keyVersion) && Number(header.keyVersion) > 0
        && Number.isSafeInteger(header.seq) && header.seq >= 0;
}

function isOpaqueV2TerminalFrame(raw: string): boolean {
    try {
        const envelope = JSON.parse(raw) as Envelope;
        return isOpaqueV2Envelope(envelope) && envelope.header.channel === 'terminal';
    } catch {
        return false;
    }
}

function isOpaqueV2StreamFrame(raw: string): boolean {
    try {
        const envelope = JSON.parse(raw) as Envelope;
        return isOpaqueV2Envelope(envelope) && envelope.header.channel === 'stream';
    } catch {
        return false;
    }
}

export interface RelayOptions {
    port: number;
    host?: string;
    config?: Partial<RelayConfig>;
    /** Extra HTTP routes (the cloud control plane mounts here). Return true when handled. */
    httpHandlers?: Array<(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<boolean>>;
    /** Ticket consumer override. Default: the file-backed local authority. */
    consumeTicket?: (ticket: string) => Promise<Ticket | undefined>;
    /** Readiness probe override for an embedding process. Default: always ready. */
    readyCheck?: () => Promise<boolean>;
    now?: () => Date;
}

export interface RelayHandle {
    close: () => Promise<void>;
    port: number;
    /** Close every socket whose identity matches the scope (cloud revocation hook). */
    revokePeers: (scope: { accountId: string; machineSlug?: string; deviceId?: string }) => void;
    /** Count of connected client sockets for an account (cloud entitlement metering). */
    countClients: (accountId: string) => number;
}

export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
    const config = loadRelayConfig({
        port: options.port,
        ...(options.host === undefined ? {} : { host: options.host }),
        ...options.config,
    });

    const authenticatedSockets = new Set<{ socket: WebSocket; identity: PeerIdentity }>();
    const peers = new PeerTable();
    const now = options.now ?? (() => new Date());
    const closePeers = (scope: { accountId: string; machineSlug?: string; deviceId?: string }, reason: string): void => {
        for (const peer of authenticatedSockets) {
            if (peer.identity.kind === 'legacy' || peer.identity.accountId !== scope.accountId) continue;
            if (scope.machineSlug !== undefined && !peer.identity.machineIds.has(scope.machineSlug)) continue;
            if (scope.deviceId !== undefined
                && (peer.identity.kind !== 'ticket' || peer.identity.deviceId !== scope.deviceId)) continue;
            peer.socket.close(1008, reason);
        }
    };
    const revokePeers = (scope: { accountId: string; machineSlug?: string; deviceId?: string }): void => {
        closePeers(scope, 'revoked');
    };
    const registry = new MachineRegistry(config.dataDir);
    const offline = new OfflineBuffer(config.dataDir, config.bufferLimit, config.bufferTtlMs);
    const replay = new ReplayLog(config.dataDir, config.replayLimit, config.replayTtlMs);
    const startedAt = Date.now();
    const authMode = config.authMode === 'strict' ? 'strict' : 'permissive';

    const pushWebhook: PushWebhookConfig | undefined =
        config.pushWebhookUrl === undefined
            ? undefined
            : {
                  url: config.pushWebhookUrl,
                  maxRetries: config.pushWebhookRetries,
                  timeoutMs: config.pushWebhookTimeoutMs,
              };

    const pairing = new PairingRequests();
    const previews = new PreviewChannels();
    const terminals = new TerminalChannels();
    const realtimeStreams = new TerminalChannels();
    const push = new PushService(config.dataDir);
    const localTickets = config.localAuthority ? new FileTicketStore(config.dataDir) : undefined;
    const localPairing = config.localAuthority ? new SelfhostPairing(config.dataDir) : undefined;
    const notifications = config.localAuthority ? notificationEmailFromEnv() : undefined;
    // One email per machine per 5 minutes — a flap loop must not spam.
    const lastNotified = new Map<string, number>();
    const notifyOffline = notifications === undefined
        ? undefined
        : async (machineId: string): Promise<void> => {
              const last = lastNotified.get(machineId) ?? 0;
              if (Date.now() - last < 5 * 60_000) return;
              lastNotified.set(machineId, Date.now());
              await notifications.mailer.send({
                  to: notifications.to,
                  subject: `muxr: machine offline — ${machineId}`,
                  text: `Machine ${machineId} disconnected from your relay and is no longer reachable from your phone.\n\nIf this was not expected, check the host and relay on that machine.`,
              });
          };
    // Mint secret gates self-host ticket issuance: filesystem read access to the
    // dataDir is the same-machine boundary (a proxy makes every request loopback).
    const mintSecret = config.localAuthority ? await ensureMintSecret(config.dataDir) : undefined;
    // Minimal per-IP fixed-window limiter for the self-host HTTP surface.
    const rateBuckets = new Map<string, { windowStart: number; count: number }>();
    const rateLimited = (ip: string, limit: number, windowMs: number, now: number): boolean => {
        if (rateBuckets.size > 10_000) rateBuckets.clear();
        const bucket = rateBuckets.get(ip);
        if (bucket === undefined || now - bucket.windowStart >= windowMs) {
            rateBuckets.set(ip, { windowStart: now, count: 1 });
            return false;
        }
        bucket.count += 1;
        return bucket.count > limit;
    };

    await registry.load();
    await offline.load();
    await replay.load();
    await push.load();

    /** sessionId -> owning machineId, learned from envelope headers (the only part the relay reads). */
    const sessionOwner = new Map<string, string>();
    /** requestId -> resolver for in-flight synthetic requests awaiting the machine's answer. */
    const pendingPushActions = new Map<string, (outcome: PushActionOutcome) => void>();
    let lastSyntheticSeq = 0;

    /**
     * A synthetic client request envelope, crafted by the relay (push/action,
     * attachment downloads). This is the ONE sanctioned place the relay reads
     * AND writes payloads: the host cannot be reached otherwise, and the
     * request is answered like any other client request. E2EE is rejected
     * before this is ever reached.
     */
    function nextSyntheticSeq(): number {
        const seq = Math.max(Date.now(), lastSyntheticSeq + 1);
        lastSyntheticSeq = seq;
        return seq;
    }

    /**
     * Returns true when the envelope answered a synthetic request: it is then
     * CONSUMED, never routed -- a 300MB attachment result has no business
     * being fanned out to every connected client socket.
     */
    function settlePushAction(envelope: Envelope): boolean {
        try {
            const frame = decodePayload<HostFrame>(envelope.payload);
            if (frame.type !== 'result') return false;
            const resolve = pendingPushActions.get(frame.requestId);
            if (resolve === undefined) return false;
            pendingPushActions.delete(frame.requestId);
            resolve(
                frame.ok
                    ? { ok: true, status: 200, data: frame.data }
                    : { ok: false, status: 502, error: frame.error },
            );
            return true;
        } catch {
            return false;
        }
    }

    /** Send a synthetic client request to a machine and await its result. */
    function machineRequest(input: {
        machineId: string;
        sessionId?: string;
        timeoutMs?: number;
    } & (
        | { type: 'session.answer'; params: { sessionId: string; answer: 'y' | 'n' } }
        | { type: 'attachment.fetch'; params: { sessionId: string; attachmentId: string } }
        | { type: 'attachment.prepare'; params: { sessionId: string; attachmentId: string } }
    )): Promise<PushActionOutcome> {
        if (config.e2eeMode === 'on') {
            return Promise.resolve({
                ok: false,
                status: 503,
                error: 'synthetic requests cannot cross an E2EE machine link; the caller must use the encrypted envelope channel',
            });
        }
        const machines = peers.forMachine(input.machineId, 'machine');
        if (machines.length === 0) {
            return Promise.resolve({ ok: false, status: 503, error: 'machine offline' });
        }
        const requestId = nextRequestId('push');
        const envelope: Envelope = {
            header: {
                machineId: input.machineId,
                ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
                seq: nextSyntheticSeq(),
                at: Date.now(),
            },
            payload: encodePayload(
                input.type === 'session.answer'
                    ? { type: 'session.answer', requestId, params: input.params }
                    : input.type === 'attachment.fetch'
                      ? { type: 'attachment.fetch', requestId, params: input.params }
                      : { type: 'attachment.prepare', requestId, params: input.params },
            ),
        };
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingPushActions.delete(requestId);
                resolve({ ok: false, status: 504, error: 'machine did not answer in time' });
            }, input.timeoutMs ?? PUSH_ACTION_TIMEOUT_MS);
            pendingPushActions.set(requestId, (outcome) => {
                clearTimeout(timer);
                resolve(outcome);
            });
            for (const peer of machines) sendEnvelope(peer.socket, envelope);
        });
    }

    function pushAction(input: {
        machineId: string;
        sessionId: string;
        answer: 'y' | 'n';
    }): Promise<PushActionOutcome> {
        return machineRequest({
            machineId: input.machineId,
            sessionId: input.sessionId,
            type: 'session.answer',
            params: { sessionId: input.sessionId, answer: input.answer },
        });
    }

    const hostDownloadBaseUrl = process.env.MUXR_HOST_HTTP_URL ?? 'http://127.0.0.1:8793';
    const webRoot = process.env.MUXR_WEB_ROOT?.trim();
    const webMime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
    const serveWeb = async (pathname: string, head: boolean, res: import('node:http').ServerResponse): Promise<boolean> => {
        if (!config.localAuthority || !webRoot || pathname.startsWith('/v1/') || pathname === '/health' || pathname === '/ready') return false;
        const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
        if (relative.startsWith('..')) return false;
        let path = join(webRoot, relative || 'index.html');
        try { if ((await stat(path)).isDirectory()) path = join(path, 'index.html'); }
        catch { path = join(webRoot, 'index.html'); }
        try {
            const body = await readFile(path);
            res.writeHead(200, {
                'content-type': webMime[extname(path).toLowerCase()] ?? 'application/octet-stream',
                'cache-control': path.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
                'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
                'x-content-type-options': 'nosniff',
                'referrer-policy': 'no-referrer',
            });
            res.end(head ? undefined : body);
            return true;
        } catch { return false; }
    };
    const http = createServer((req, res) => {
        void (async () => {
            if (!applyHttpOriginPolicy(req, res, config)) return;
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            if (!config.developmentApi && url.pathname !== '/health' && url.pathname !== '/ready'
                && url.pathname !== '/v1/selfhost/tickets' && url.pathname !== '/v1/ws-tickets'
                && rateLimited(`http:${clientIp(req, config.trustProxy)}`, 300, 60_000, Date.now())) {
                writeJsonError(res, 429, 'too many requests');
                return;
            }
            if (req.method === 'GET' && url.pathname === '/health') {
                const online = peers.onlineMachineIds();
                writeJson(res, 200, {
                    ok: true,
                    uptimeMs: Date.now() - startedAt,
                    e2eeMode: config.e2eeMode,
                    connectedPeers: peers.counts().total,
                    onlineMachines: online.size,
                    ...(config.localAuthority ? { registeredMachines: registry.registeredMachineCount(), webEnabled: webRoot !== undefined, bindHost: config.host } : {}),
                });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/ready') {
                const ready = options.readyCheck === undefined ? true : await options.readyCheck();
                writeJson(res, ready ? 200 : 503, { ok: ready });
                return;
            }
            if ((req.method === 'GET' || req.method === 'HEAD') && await serveWeb(url.pathname, req.method === 'HEAD', res)) return;
            // Self-host ticket issuance: mint secret (0600 file in dataDir) proves
            // same-box access; a proxyed request cannot satisfy it.
            if (config.localAuthority && localTickets !== undefined
                && req.method === 'POST' && (url.pathname === '/v1/selfhost/tickets' || url.pathname === '/v1/ws-tickets')) {
                const ip = `mint:${clientIp(req, config.trustProxy)}`;
                const presented = extractBearerToken(req);
                // Two bearers can mint: the mint secret (CLI on this box) or a
                // paired device credential (the phone, after pairing).
                const device = presented === undefined || localPairing === undefined
                    ? undefined
                    : await localPairing.resolveDeviceCredential(presented);
                if (device === undefined
                    && (presented === undefined || mintSecret === undefined || !secureEqual(mintSecret, presented))) {
                    // Limit failures only: valid credentials are never throttled.
                    if (rateLimited(ip, 10, 60_000, Date.now())) {
                        writeJsonError(res, 429, 'too many requests');
                        return;
                    }
                    writeJsonError(res, 403, 'ticket minting requires the relay mint secret or a paired device credential');
                    return;
                }
                const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                if (body?.transport === 'preview' && config.e2eeMode === 'on') {
                    writeJsonError(res, 400, 'preview is unavailable with E2EE on');
                    return;
                }
                const role = body?.role;
                const machineSlug = (typeof body?.machineSlug === 'string' ? body.machineSlug
                    : typeof body?.machineId === 'string' ? body.machineId
                    : typeof body?.machine_id === 'string' ? body.machine_id : '').trim();
                const transport = body?.transport;
                if ((role !== 'machine' && role !== 'client') || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineSlug)
                    || (transport !== 'relay' && transport !== 'terminal' && transport !== 'preview' && transport !== 'stream')) {
                    writeJsonError(res, 400, 'role, machineSlug and transport are required');
                    return;
                }
                if (device !== undefined && role !== 'client') {
                    writeJsonError(res, 403, 'device credentials mint client tickets only');
                    return;
                }
                if (device !== undefined && device.machineSlug !== machineSlug) {
                    writeJsonError(res, 403, 'device credential is not paired to this machine');
                    return;
                }
                const ticket = await localTickets.issue({
                    role,
                    machineSlug,
                    accountId: `local:${machineSlug}`,
                    transport,
                    ...(typeof body?.channel === 'string' && body.channel !== '' && body.channel.length <= 128 ? { channel: body.channel } : {}),
                    ...(device !== undefined ? { deviceId: device.deviceId } : {}),
                });
                writeJson(res, 200, { ticket, expires_in: 60 });
                return;
            }
            // Self-host pairing: CLI opens sessions with the mint secret; the phone
            // claims with the one-time claim from the QR, then uses its device
            // credential for grants and tickets.
            if (config.localAuthority && localPairing !== undefined && url.pathname.startsWith('/v1/selfhost/pair-sessions')) {
                const mintOk = (): boolean => {
                    const presented = extractBearerToken(req);
                    return presented !== undefined && mintSecret !== undefined && secureEqual(mintSecret, presented);
                };
                const claimMatch = /^\/v1\/selfhost\/pair-sessions\/([^/]+)\/claim$/.exec(url.pathname);
                const grantMatch = /^\/v1\/selfhost\/pair-sessions\/([^/]+)\/grant$/.exec(url.pathname);
                const pollMatch = /^\/v1\/selfhost\/pair-sessions\/([^/]+)$/.exec(url.pathname);
                if (req.method === 'POST' && url.pathname === '/v1/selfhost/pair-sessions') {
                    if (!mintOk()) { writeJsonError(res, 403, 'pair sessions are opened with the relay mint secret'); return; }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const claim = typeof body?.claim === 'string' ? body.claim : '';
                    const machineSlug = typeof body?.machineSlug === 'string' ? body.machineSlug.trim() : '';
                    if (claim.length < 43 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineSlug)) {
                        writeJsonError(res, 400, 'claim and machineSlug are required');
                        return;
                    }
                    const session = await localPairing.createSession({ claim, machineSlug });
                    writeJson(res, 201, { pair_id: session.pairId, expires_in: session.expiresIn });
                    return;
                }
                if (req.method === 'POST' && claimMatch?.[1] !== undefined) {
                    if (rateLimited(`claim:${clientIp(req, config.trustProxy)}`, 20, 60_000, Date.now())) {
                        writeJsonError(res, 429, 'too many requests');
                        return;
                    }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const claim = typeof body?.claim === 'string' ? body.claim : '';
                    const devicePublicKey = typeof body?.device_public_key === 'string' ? body.device_public_key : '';
                    const deviceName = typeof body?.device_name === 'string' ? body.device_name.slice(0, 120) : '';
                    const mailbox = typeof body?.mailbox === 'string' ? body.mailbox : '';
                    const browserExpiresAt = body?.device_kind === 'browser' ? Date.now() + 8 * 60 * 60_000 : undefined;
                    if (claim === '' || devicePublicKey === '' || deviceName === '' || mailbox === '' || mailbox.length > 16 * 1024) {
                        writeJsonError(res, 400, 'claim, device_public_key, device_name and mailbox are required');
                        return;
                    }
                    const result = await localPairing.claim(claimMatch[1], {
                        claim, devicePublicKey, deviceName, mailbox,
                        ...(browserExpiresAt === undefined ? {} : { expiresAt: browserExpiresAt }),
                    });
                    if (result.state === 'issued') {
                        writeJson(res, 201, { device_id: result.deviceId, device_credential: result.credential });
                    } else {
                        writeJsonError(res, result.state === 'invalid_claim' ? 403 : result.state === 'expired' ? 400 : 409, result.state);
                    }
                    return;
                }
                if (req.method === 'GET' && pollMatch?.[1] !== undefined) {
                    if (!mintOk()) { writeJsonError(res, 403, 'pair polling requires the relay mint secret'); return; }
                    writeJson(res, 200, await localPairing.poll(pollMatch[1]));
                    return;
                }
                if (grantMatch?.[1] !== undefined) {
                    if (req.method === 'POST') {
                        if (!mintOk()) { writeJsonError(res, 403, 'grant upload requires the relay mint secret'); return; }
                        const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                        const grant = typeof body?.grant === 'string' ? body.grant : '';
                        if (grant === '' || grant.length > 16 * 1024) { writeJsonError(res, 400, 'grant is required'); return; }
                        if (!(await localPairing.uploadGrant(grantMatch[1], grant))) { writeJsonError(res, 404, 'pair_session_unavailable'); return; }
                        writeJson(res, 200, { ok: true });
                        return;
                    }
                    if (req.method === 'GET') {
                        const presented = extractBearerToken(req);
                        const device = presented === undefined ? undefined : await localPairing.resolveDeviceCredential(presented);
                        if (device === undefined) { writeJsonError(res, 403, 'grant download requires a paired device credential'); return; }
                        const grant = await localPairing.fetchGrant(grantMatch[1], device.deviceId);
                        if (grant === undefined) { writeJsonError(res, 404, 'grant_not_available'); return; }
                        writeJson(res, 200, { grant });
                        return;
                    }
                }
                writeJsonError(res, 404, 'not_found');
                return;
            }
            if (config.localAuthority && localPairing !== undefined && req.method === 'GET'
                && url.pathname === '/v1/selfhost/devices') {
                const presented = extractBearerToken(req);
                if (presented === undefined || mintSecret === undefined || !secureEqual(mintSecret, presented)) {
                    writeJsonError(res, 403, 'device listing requires the relay mint secret');
                    return;
                }
                const machineSlug = url.searchParams.get('machine')?.trim() ?? '';
                if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineSlug)) {
                    writeJsonError(res, 400, 'machine is required');
                    return;
                }
                writeJson(res, 200, { devices: await localPairing.listDevices(machineSlug) });
                return;
            }
            const machineGrantMatch = /^\/v1\/machines\/([^/]+)\/grant$/.exec(url.pathname);
            if (config.localAuthority && localPairing !== undefined && req.method === 'GET' && machineGrantMatch?.[1] !== undefined) {
                const presented = extractBearerToken(req);
                const device = presented === undefined ? undefined : await localPairing.resolveDeviceCredential(presented);
                const machineSlug = decodeURIComponent(machineGrantMatch[1]);
                if (device === undefined || device.machineSlug !== machineSlug) {
                    writeJsonError(res, 403, 'grant download requires a paired device credential');
                    return;
                }
                const grant = await localPairing.fetchCurrentGrant(device.deviceId, machineSlug);
                if (grant === undefined) { writeJsonError(res, 404, 'grant_not_available'); return; }
                writeJson(res, 200, { grant });
                return;
            }
            const rotatedGrantsMatch = /^\/v1\/selfhost\/machines\/([^/]+)\/grants$/.exec(url.pathname);
            if (config.localAuthority && localPairing !== undefined && req.method === 'POST' && rotatedGrantsMatch?.[1] !== undefined) {
                const presented = extractBearerToken(req);
                if (presented === undefined || mintSecret === undefined || !secureEqual(mintSecret, presented)) {
                    writeJsonError(res, 403, 'grant rotation requires the relay mint secret');
                    return;
                }
                const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                const keyVersion = body?.key_version;
                const entries = Array.isArray(body?.grants) ? body.grants : [];
                const grants = entries.flatMap((entry) => {
                    if (typeof entry !== 'object' || entry === null) return [];
                    const item = entry as Record<string, unknown>;
                    return typeof item.device_id === 'string' && typeof item.grant === 'string' && item.grant.length <= 16 * 1024
                        ? [{ deviceId: item.device_id, grant: item.grant }] : [];
                });
                if (grants.length !== entries.length || typeof keyVersion !== 'number'
                    || !(await localPairing.storeCurrentGrants(decodeURIComponent(rotatedGrantsMatch[1]), keyVersion, grants))) {
                    writeJsonError(res, 409, 'rotation_grants_invalid');
                    return;
                }
                // Force every remaining peer to reconnect and refresh the new
                // grant. This also reconnects the host after its local key swap.
                const machineSlug = decodeURIComponent(rotatedGrantsMatch[1]);
                closePeers({ accountId: `local:${machineSlug}`, machineSlug }, 'keys rotated');
                writeJson(res, 200, { ok: true, key_version: keyVersion });
                return;
            }
            // Device revocation: mint-secret authed, immediate.
            if (config.localAuthority && localPairing !== undefined && req.method === 'DELETE'
                && url.pathname.startsWith('/v1/selfhost/devices/')) {
                const presented = extractBearerToken(req);
                if (presented === undefined || mintSecret === undefined || !secureEqual(mintSecret, presented)) {
                    writeJsonError(res, 403, 'device revocation requires the relay mint secret');
                    return;
                }
                const deviceId = decodeURIComponent(url.pathname.slice('/v1/selfhost/devices/'.length));
                const revoked = await localPairing.revokeDevice(deviceId);
                if (revoked === undefined) {
                    writeJsonError(res, 404, 'device_not_found');
                    return;
                }
                revokePeers({ accountId: `local:${revoked.machineSlug}`, deviceId });
                writeJson(res, 200, { ok: true });
                return;
            }
            for (const handler of options.httpHandlers ?? []) {
                if (await handler(req, res, url)) return;
            }
            if (!config.developmentApi) {
                writeJson(res, 404, { error: 'not_found' });
                return;
            }
            await handleHttpRequest(req, res, {
                pairing,
                registry,
                peers,
                offline,
                replay,
                startedAt,
                e2eeMode: config.e2eeMode,
                droppedCount: () => offline.droppedCount,
                push,
                pushAction,
                machineRequest,
                hostDownloadBaseUrl,
                sessionOwnerOf: (sessionId) => sessionOwner.get(sessionId),
            });
        })().catch(() => {
            process.stderr.write('relay HTTP request failed\n');
            if (!res.headersSent) writeJsonError(res, 500, 'internal error');
        });
    });
    http.requestTimeout = config.publicEdge ? 30_000 : 0;
    http.headersTimeout = 15_000;

    const wss = new WebSocketServer({ server: http, maxPayload: config.maxPayloadBytes });

    wss.on('connection', (socket, req) => {
        void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!config.developmentApi
            && rateLimited(`ws:${clientIp(req, config.trustProxy)}`, 60, 60_000, Date.now())) {
            socket.close(1008, 'too many requests');
            return;
        }
        if (!webSocketOriginAllowed(req, config)) {
            socket.close(1008, 'origin not allowed');
            return;
        }
        const identity = await authenticateWebSocket({
            req,
            url,
            authMode,
            remoteAddress: req.socket.remoteAddress,
            consumeTicket: options.consumeTicket
                ?? ((ticket) => localTickets?.consume(ticket) ?? Promise.resolve(undefined)),
            // Legacy registry tokens exist only for the loopback dev harness.
        });

        if (!identity) {
            process.stderr.write('rejected unauthorized WebSocket\n');
            socket.close(1008, 'unauthorized');
            return;
        }
        if (config.localAuthority && localPairing !== undefined && identity.kind === 'ticket'
            && identity.deviceId !== undefined && !(await localPairing.isDeviceActive(identity.deviceId))) {
            socket.close(1008, 'revoked');
            return;
        }
        const transport = url.pathname.endsWith('/preview')
            ? 'preview'
            : url.pathname.endsWith('/terminal') ? 'terminal' : url.pathname.endsWith('/stream') ? 'stream' : 'relay';
        if (identity.kind === 'ticket' && identity.transport !== transport) {
            socket.close(1008, 'ticket scope mismatch');
            return;
        }
        if (config.e2eeMode === 'on' && transport === 'preview') {
            socket.close(1008, 'preview requires cleartext framing and is unavailable with E2EE on');
            return;
        }
        const authenticatedSocket = { socket, identity };
        authenticatedSockets.add(authenticatedSocket);
        socket.once('close', () => authenticatedSockets.delete(authenticatedSocket));

        // Preview sockets carry raw tunnel bytes, not envelopes. They never join
        // the peer table, so nothing downstream can route a session envelope at
        // one, and their traffic never reaches the replay log or offline buffer.
        // endsWith, not ===: a relay behind a path-prefixed proxy (wss://host/relay)
        // sees /relay/preview.
        if (url.pathname.endsWith('/preview')) {
            const channel = identity.kind === 'ticket' ? identity.channel : url.searchParams.get('channel')?.trim();
            const machineId = identity.kind === 'ticket' ? [...identity.machineIds][0] : url.searchParams.get('machineId')?.trim();
            if (!channel || !machineId || !identity.machineIds.has(machineId)) {
                socket.close(1008, 'preview requires channel and an authorized machineId');
                return;
            }
            const accountId = identity.kind === 'legacy' ? 'local' : identity.accountId;
            const key = `${accountId.length}:${accountId}${machineId.length}:${machineId}${channel}`;
            if (identity.role === 'machine') {
                previews.joinMachine(key, socket);
            } else {
                // Same interface the relay itself is reachable on, so a preview
                // reaches exactly as far as the session link does.
                void previews.joinClient(key, socket, config.host, req.socket.remoteAddress);
            }
            return;
        }

        if (url.pathname.endsWith('/terminal') || url.pathname.endsWith('/stream')) {
            const isStream = url.pathname.endsWith('/stream');
            const channel = identity.kind === 'ticket' ? identity.channel : url.searchParams.get('channel')?.trim();
            const machineId = identity.kind === 'ticket' ? [...identity.machineIds][0] : url.searchParams.get('machineId')?.trim();
            if (!channel || !machineId || !identity.machineIds.has(machineId)) {
                socket.close(1008, `${isStream ? 'stream' : 'terminal'} requires channel and an authorized machineId`);
                return;
            }
            const accountId = identity.kind === 'legacy' ? 'local' : identity.accountId;
            const key = `${accountId.length}:${accountId}${machineId.length}:${machineId}${channel}`;
            const channels = isStream ? realtimeStreams : terminals;
            const accept = config.e2eeMode === 'on' ? (isStream ? isOpaqueV2StreamFrame : isOpaqueV2TerminalFrame) : undefined;
            if (identity.role === 'machine') {
                channels.joinMachine(key, socket, accept);
            } else {
                void channels.joinClient(key, socket, accept);
            }
            return;
        }

        const lastSeenSeq = parseLastSeq(url);
        const peer: ConnectedPeer = {
            socket,
            identity,
            accountId: identity.kind === 'legacy' ? 'local' : identity.accountId,
            role: identity.role,
            machineIds: identity.machineIds,
            connectedAt: Date.now(),
            ...(lastSeenSeq === undefined ? {} : { lastSeenSeq }),
        };
        // One host per machineId. Two hosts both answer every request, and the
        // one that did not create a session replies "unknown session".
        if (peer.role === 'machine') {
            for (const machineId of peer.machineIds) {
                for (const stale of peers.forMachine(machineId, 'machine', peer.accountId)) {
                    peers.remove(stale);
                    stale.socket.close(RELAY_CLOSE_REPLACED, 'replaced by a newer host');
                }
            }
        }
        peers.add(peer);

        deliverReplayAndOffline(peer, offline, replay,
            // Persisted frames predate strict E2EE; never deliver cleartext into an E2EE link.
            config.e2eeMode === 'on' ? isOpaqueV2Envelope : undefined);

        socket.on('message', (raw) => {
            let envelope: Envelope;
            try {
                envelope = JSON.parse(String(raw)) as Envelope;
            } catch {
                return;
            }
            if (!envelope?.header?.machineId) return;
            if (config.e2eeMode === 'on' && !isOpaqueV2Envelope(envelope)) {
                socket.close(1008, 'relay requires opaque v2 ciphertext');
                return;
            }
            if (!peerMayRoute(envelope.header.machineId, peer)) return;
            // Header-only learning happens only after route authorization.
            // The map feeds the dev-only synthetic HTTP API, so only dev populates it.
            if (config.developmentApi && envelope.header.sessionId !== undefined) {
                sessionOwner.set(envelope.header.sessionId, envelope.header.machineId);
            }
            if (config.developmentApi && peer.role === 'machine' && settlePushAction(envelope)) return;
            routeEnvelope(
                envelope,
                peer,
                peers,
                offline,
                replay,
                pushWebhook === undefined ? {} : { pushWebhook },
            );
        });

        const detach = (): void => {
            peers.remove(peer);
            // BYO-email notify: the last machine peer dropping means the box went offline.
            if (notifyOffline !== undefined && peer.role === 'machine'
                && peers.forMachine(peer.machineIds.values().next().value ?? '', 'machine', peer.accountId).length === 0) {
                void notifyOffline([...peer.machineIds][0] ?? 'unknown').catch(() => undefined);
            }
        };
        socket.on('close', detach);
        socket.on('error', detach);
        })().catch(() => {
            process.stderr.write('WebSocket authentication failed\n');
            socket.close(1011, 'authentication failed');
        });
    });

    // Tunnels (cloudflared, ngrok) close idle WebSockets, which the app shows as
    // a connect/disconnect flap. Browsers cannot send pings, so the server drives
    // it; the client pongs automatically.
    const keepalive = setInterval(() => {
        for (const client of wss.clients) {
            if (client.readyState === client.OPEN) client.ping();
        }
    }, 30_000);
    keepalive.unref();

    await new Promise<void>((resolve) => http.listen(config.port, config.host, resolve));
    const address = http.address();
    const listeningPort = typeof address === 'object' && address !== null ? address.port : config.port;

    // LAN discovery: advertise _muxr._tcp so the app can find self-host relays.
    let bonjourStop: (() => void) | undefined;
    if (config.advertiseMdns) {
        try {
            const { default: Bonjour } = await import('bonjour-service');
            const bonjour = new Bonjour();
            const service = bonjour.publish({
                name: `muxr-${hostname()}`,
                type: 'muxr',
                protocol: 'tcp',
                port: listeningPort,
                txt: { v: '2' },
            });
            bonjourStop = () => {
                service.stop();
                bonjour.destroy();
            };
        } catch {
            process.stderr.write('mDNS advertisement unavailable; discovery disabled\n');
        }
    }

    return {
        port: listeningPort,
        revokePeers,
        countClients: (accountId) => authenticatedSockets.size === 0 ? 0 : [...authenticatedSockets].filter(
            (peer) => peer.identity.kind === 'ticket' && peer.identity.role === 'client' && peer.identity.accountId === accountId,
        ).length,
        close: async () => {
            clearInterval(keepalive);
            bonjourStop?.();
            previews.closeAll();
            terminals.closeAll();
            realtimeStreams.closeAll();
            peers.closeAll();
            authenticatedSockets.clear();
            wss.close();
            await awaitPersistChain();
            await new Promise<void>((resolve) => http.close(() => resolve()));
        },
    };
}

function applyHttpOriginPolicy(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    config: RelayConfig,
): boolean {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (config.publicEdge) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const origin = req.headers.origin;
    if (origin === undefined || (!config.publicEdge && config.allowedOrigins.size === 0)) return true;
    if (typeof origin !== 'string' || !config.allowedOrigins.has(origin)) {
        writeJsonError(res, 403, 'origin not allowed');
        return false;
    }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('vary', 'Origin');
    return true;
}

function webSocketOriginAllowed(req: import('node:http').IncomingMessage, config: RelayConfig): boolean {
    const origin = req.headers.origin;
    if (origin === undefined || (!config.publicEdge && config.allowedOrigins.size === 0)) return true;
    return typeof origin === 'string' && config.allowedOrigins.has(origin);
}

function writeJsonError(res: import('node:http').ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
}
