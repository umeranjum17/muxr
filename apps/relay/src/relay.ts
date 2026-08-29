/**
 * The relay. A pipe.
 *
 * Reads ONLY envelope.header. Never parses envelope.payload.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { hostname } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import {
    RELAY_CLOSE_REPLACED,
    decodePayload,
    isPeerCapabilities,
    encodePayload,
    nextRequestId,
    parseLifecycleNotificationLevel,
    type Envelope,
    type HostFrame,
} from '@muxr/contract';
import { admitSocketFromUrl, extractBearerToken, secureEqual, admittedByTicket, type PeerIdentity, type Ticket } from './admission/index.js';
import { handleHttpRequest, isExpoPushToken, readJsonBody, writeJson, writeJsonError, type PushActionOutcome } from './httpHandlers.js';
import { OfflineBuffer, PeerTable, parseLastSeq, peerMayRoute, sendEnvelope, type ConnectedPeer, PreviewChannels, TerminalChannels, ReplayLog, deliverReplayAndOffline, routeEnvelope, type PeerRouteOutcome } from './routing/index.js';
import { type RelayConfig, clientIp, isLoopbackAddress, loadRelayConfig } from './config.js';
import { isValidPublicKey, PairingRequests, FileTicketStore, SelfhostPairing, MachineAuthority, enrollmentProofMessage, MachineRegistry } from './admission/index.js';
import { parsePushNotification, PushService, notificationEmailFromEnv, type PushWebhookConfig } from './push/index.js';
import { awaitPersistChain, writeJsonFileAtomic, readPrivateFile } from './platform/persist.js';

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
            if (peer.identity.accountId !== scope.accountId) continue;
            if (scope.machineSlug !== undefined && !peer.identity.machineIds.has(scope.machineSlug)) continue;
            if (scope.deviceId !== undefined && peer.identity.deviceId !== scope.deviceId) continue;
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
    const peerRouteEvents: Array<{ at: string; event: 'peer.route'; direction: 'client-to-host'; outcome: PeerRouteOutcome }> = [];
    const recordPeerRoute = (outcome: PeerRouteOutcome): void => {
        const now = Date.now();
        peerRouteEvents.push({ at: new Date(now).toISOString(), event: 'peer.route', direction: 'client-to-host', outcome });
        while (peerRouteEvents.length > 64 || Date.parse(peerRouteEvents[0]?.at ?? '') < now - 15 * 60_000) peerRouteEvents.shift();
    };
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
    const machineAuthority = config.localAuthority ? new MachineAuthority(config.dataDir) : undefined;
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
    const resolveAuthority = async (req: Parameters<typeof extractBearerToken>[0]) => {
        const presented = extractBearerToken(req);
        const owner = presented !== undefined && mintSecret !== undefined && secureEqual(mintSecret, presented);
        const machine = !owner && presented !== undefined && machineAuthority !== undefined
            ? await machineAuthority.resolveCredential(presented)
            : undefined;
        return { presented, owner, machine };
    };
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
        let payload;
        if (input.type === 'session.answer') {
            payload = encodePayload({ type: 'session.answer', requestId, params: input.params });
        } else if (input.type === 'attachment.fetch') {
            payload = encodePayload({ type: 'attachment.fetch', requestId, params: input.params });
        } else {
            payload = encodePayload({ type: 'attachment.prepare', requestId, params: input.params });
        }
        const envelope: Envelope = {
            header: {
                machineId: input.machineId,
                ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
                seq: nextSyntheticSeq(),
                at: Date.now(),
            },
            payload,
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
                'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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
                    ...(config.localAuthority && isLoopbackAddress(req.socket.remoteAddress)
                        ? { registeredMachines: registry.registeredMachineCount(), webEnabled: webRoot !== undefined, bindHost: config.host }
                        : {}),
                });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/ready') {
                const ready = options.readyCheck === undefined ? true : await options.readyCheck();
                writeJson(res, ready ? 200 : 503, { ok: ready });
                return;
            }
            if (config.localAuthority && req.method === 'GET' && url.pathname === '/v1/selfhost/route-diagnostics') {
                const authority = await resolveAuthority(req);
                if (!authority.owner) { writeJsonError(res, 403, 'route diagnostics require relay owner authority'); return; }
                const cutoff = Date.now() - 15 * 60_000;
                writeJson(res, 200, {
                    note: 'bounded redacted peer routes; timestamps and outcomes only',
                    windowMinutes: 15,
                    events: peerRouteEvents.filter((event) => Date.parse(event.at) >= cutoff),
                });
                return;
            }
            if ((req.method === 'GET' || req.method === 'HEAD') && await serveWeb(url.pathname, req.method === 'HEAD', res)) return;
            if (config.localAuthority && machineAuthority !== undefined && url.pathname.startsWith('/v1/selfhost/enrollments')) {
                const claimMatch = /^\/v1\/selfhost\/enrollments\/([^/]+)\/claim$/.exec(url.pathname);
                if (req.method === 'POST' && url.pathname === '/v1/selfhost/enrollments') {
                    const authority = await resolveAuthority(req);
                    if (!authority.owner) { writeJsonError(res, 403, 'enrollment creation requires relay owner authority'); return; }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const relayUrl = typeof body?.relay_url === 'string' ? body.relay_url.trim() : '';
                    let valid = false;
                    try {
                        const parsed = new URL(relayUrl);
                        valid = parsed.protocol === 'wss:' && parsed.hostname !== '' && !parsed.username && !parsed.password
                            && parsed.pathname === '/' && !parsed.search && !parsed.hash;
                    } catch { valid = false; }
                    if (!valid) { writeJsonError(res, 400, 'relay_url must be a root wss:// URL without credentials'); return; }
                    const webUrl = typeof body?.web_url === 'string' ? body.web_url.trim().replace(/\/$/, '') : undefined;
                    if (webUrl !== undefined) {
                        try {
                            const parsed = new URL(webUrl);
                            if (parsed.protocol !== 'https:' || parsed.origin !== webUrl) throw new Error('invalid');
                        } catch { writeJsonError(res, 400, 'web_url must be an origin-only https:// URL'); return; }
                    }
                    const enrollment = await machineAuthority.createEnrollment(relayUrl.replace(/\/$/, ''), webUrl);
                    writeJson(res, 201, { enrollment_id: enrollment.id, claim: enrollment.claim, expires_in: enrollment.expiresIn,
                        relay_url: relayUrl.replace(/\/$/, ''), ...(webUrl === undefined ? {} : { web_url: webUrl }) });
                    return;
                }
                if (req.method === 'POST' && claimMatch?.[1] !== undefined) {
                    if (rateLimited(`enroll:${clientIp(req, config.trustProxy)}`, 10, 60_000, Date.now())) {
                        writeJsonError(res, 429, 'too many requests'); return;
                    }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const claim = typeof body?.claim === 'string' ? body.claim : '';
                    const relayUrl = typeof body?.relay_url === 'string' ? body.relay_url : '';
                    const signingPublicKey = typeof body?.signing_public_key === 'string' ? body.signing_public_key : '';
                    const proof = typeof body?.proof === 'string' ? body.proof : '';
                    const name = typeof body?.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 120) : 'agent machine';
                    let proofOk = false;
                    try {
                        const rawKey = Buffer.from(signingPublicKey, 'base64');
                        const signature = Buffer.from(proof, 'base64');
                        const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' });
                        proofOk = rawKey.length === 32 && rawKey.toString('base64') === signingPublicKey && signature.length === 64
                            && verify(null, enrollmentProofMessage(claimMatch[1], relayUrl, signingPublicKey), key, signature);
                    } catch { proofOk = false; }
                    if (!proofOk) { writeJsonError(res, 403, 'invalid enrollment proof'); return; }
                    const result = await machineAuthority.claimEnrollment(claimMatch[1], { claim, relayUrl, signingPublicKey, name });
                    if (result.state !== 'issued') {
                        writeJsonError(res, enrollmentClaimStatus(result.state), result.state);
                        return;
                    }
                    closePeers({ accountId: `local:${result.slug}`, machineSlug: result.slug }, 'machine re-enrolled');
                    writeJson(res, 201, { machine_slug: result.slug, machine_credential: result.credential,
                        credential_expires_at: new Date(result.expiresAt).toISOString(), relay_url: result.relayUrl,
                        ...(result.webUrl === undefined ? {} : { web_url: result.webUrl }) });
                    return;
                }
                writeJsonError(res, 404, 'not_found');
                return;
            }
            if (config.localAuthority && machineAuthority !== undefined && req.method === 'GET' && url.pathname === '/v1/selfhost/machine-status') {
                const authority = await resolveAuthority(req);
                if (authority.machine === undefined) { writeJsonError(res, 403, 'machine status requires machine authority'); return; }
                writeJson(res, 200, { online: peers.onlineMachineIds().has(authority.machine.slug) });
                return;
            }
            if (config.localAuthority && machineAuthority !== undefined && localPairing !== undefined
                && req.method === 'DELETE' && url.pathname === '/v1/selfhost/machine-status') {
                const authority = await resolveAuthority(req);
                if (authority.machine === undefined) { writeJsonError(res, 403, 'machine revocation requires machine authority'); return; }
                const slug = authority.machine.slug;
                await machineAuthority.revokeMachine(slug);
                for (const device of await localPairing.listDevices(slug)) {
                    await localPairing.revokeDevice(device.deviceId, slug);
                    await push.removeExpoDevice(`local:${slug}`, device.deviceId);
                }
                closePeers({ accountId: `local:${slug}`, machineSlug: slug }, 'machine uninstalled');
                writeJson(res, 200, { ok: true });
                return;
            }
            if (config.localAuthority && machineAuthority !== undefined && req.method === 'GET' && url.pathname === '/v1/selfhost/machines') {
                const authority = await resolveAuthority(req);
                if (!authority.owner) { writeJsonError(res, 403, 'machine listing requires relay owner authority'); return; }
                writeJson(res, 200, { machines: await machineAuthority.listMachines() });
                return;
            }
            const revokeMachineMatch = /^\/v1\/selfhost\/machines\/([^/]+)$/.exec(url.pathname);
            if (config.localAuthority && machineAuthority !== undefined && localPairing !== undefined && req.method === 'DELETE' && revokeMachineMatch?.[1] !== undefined) {
                const authority = await resolveAuthority(req);
                if (!authority.owner) { writeJsonError(res, 403, 'machine revocation requires relay owner authority'); return; }
                const slug = decodeURIComponent(revokeMachineMatch[1]);
                const revoked = await machineAuthority.revokeMachine(slug);
                if (revoked === undefined) { writeJsonError(res, 404, 'machine_not_found'); return; }
                for (const device of await localPairing.listDevices(slug)) {
                    await localPairing.revokeDevice(device.deviceId, slug);
                    await push.removeExpoDevice(`local:${slug}`, device.deviceId);
                }
                closePeers({ accountId: `local:${slug}`, machineSlug: slug }, 'machine revoked');
                writeJson(res, 200, { ok: true });
                return;
            }
            // Self-host ticket issuance: owner, enrolled machines, and paired devices use bounded authority.
            if (config.localAuthority && localTickets !== undefined
                && req.method === 'POST' && (url.pathname === '/v1/selfhost/tickets' || url.pathname === '/v1/ws-tickets')) {
                const ip = `mint:${clientIp(req, config.trustProxy)}`;
                const authority = await resolveAuthority(req);
                const device = authority.owner || authority.machine !== undefined || authority.presented === undefined || localPairing === undefined
                    ? undefined
                    : await localPairing.resolveDeviceCredential(authority.presented);
                if (!authority.owner && authority.machine === undefined && device === undefined) {
                    // Limit failures only: valid credentials are never throttled.
                    if (rateLimited(ip, 10, 60_000, Date.now())) {
                        writeJsonError(res, 429, 'too many requests');
                        return;
                    }
                    writeJsonError(res, 403, 'ticket minting requires owner, machine, or paired-device authority');
                    return;
                }
                const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                const role = body?.role;
                const machineSlug = readMachineSlug(body);
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
                if (device?.deviceKind === 'peer' && transport !== 'relay') {
                    writeJsonError(res, 403, 'peer credentials mint opaque relay tickets only');
                    return;
                }
                if (authority.machine !== undefined && role !== 'machine') {
                    writeJsonError(res, 403, 'machine credentials mint machine tickets only');
                    return;
                }
                if (authority.machine !== undefined && authority.machine.slug !== machineSlug) {
                    writeJsonError(res, 403, 'machine credential is not enrolled for this machine');
                    return;
                }
                if (device !== undefined && device.machineSlug !== machineSlug) {
                    writeJsonError(res, 403, 'device credential is not paired to this machine');
                    return;
                }
                if (!(await machineAuthority?.isMachineAllowed(machineSlug))) {
                    writeJsonError(res, 403, 'machine is revoked or expired');
                    return;
                }
                let deviceClaims = {};
                if (device !== undefined) {
                    deviceClaims = {
                        deviceId: device.deviceId,
                        deviceKind: device.deviceKind,
                        credentialVersion: device.credentialVersion,
                        ...(device.capabilities === undefined ? {} : { capabilities: device.capabilities }),
                    };
                }
                const ticket = await localTickets.issue({
                    role,
                    machineSlug,
                    accountId: `local:${machineSlug}`,
                    transport,
                    ...(typeof body?.channel === 'string' && body.channel !== '' && body.channel.length <= 128 ? { channel: body.channel } : {}),
                    ...deviceClaims,
                    ...(authority.machine !== undefined ? { machineCredentialId: authority.machine.credentialId } : {}),
                });
                writeJson(res, 200, { ticket, expires_in: 60 });
                return;
            }
            // Native short codes resolve on the selected self-host relay. The
            // relay sees only a hash and code-encrypted payload, never the code
            // or high-entropy pairing secret inside it.
            if (config.localAuthority && localPairing !== undefined && req.method === 'POST'
                && url.pathname === '/v1/selfhost/pair-code') {
                if (rateLimited(`pair-code:${clientIp(req, config.trustProxy)}`, 10, 60_000, Date.now())) {
                    writeJsonError(res, 429, 'too many requests');
                    return;
                }
                const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                const codeHash = typeof body?.code_hash === 'string' ? body.code_hash : '';
                if (!/^[A-Za-z0-9_-]{43}$/.test(codeHash)) { writeJsonError(res, 400, 'invalid_pairing_code'); return; }
                const result = await localPairing.resolveCode(codeHash);
                if (result.state !== 'resolved') {
                    const codeError = pairingCodeError(result.state);
                    writeJsonError(res, codeError.status, codeError.error);
                    return;
                }
                writeJson(res, 200, { payload: result.payload });
                return;
            }
            // Self-host pairing: CLI opens sessions with owner/machine authority;
            // the phone claims with the encrypted payload resolved by the code.
            if (config.localAuthority && localPairing !== undefined && url.pathname.startsWith('/v1/selfhost/pair-sessions')) {
                const claimMatch = /^\/v1\/selfhost\/pair-sessions\/([^/]+)\/claim$/.exec(url.pathname);
                const codeMatch = /^\/v1\/selfhost\/pair-sessions\/([^/]+)\/code$/.exec(url.pathname);
                const grantMatch = /^\/v1\/selfhost\/pair-sessions\/([^/]+)\/grant$/.exec(url.pathname);
                const completeMatch = /^\/v1\/selfhost\/pair-sessions\/([^/]+)\/complete$/.exec(url.pathname);
                const pollMatch = /^\/v1\/selfhost\/pair-sessions\/([^/]+)$/.exec(url.pathname);
                if (req.method === 'POST' && url.pathname === '/v1/selfhost/pair-sessions') {
                    const authority = await resolveAuthority(req);
                    if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'pair sessions require owner or machine authority'); return; }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const claim = typeof body?.claim === 'string' ? body.claim : '';
                    const requestedSlug = typeof body?.machineSlug === 'string' ? body.machineSlug.trim() : '';
                    if (authority.machine !== undefined && requestedSlug !== authority.machine.slug) { writeJsonError(res, 403, 'machine credential cannot pair another machine'); return; }
                    const machineSlug = authority.machine?.slug ?? requestedSlug;
                    const deviceKind = readPairingDeviceKind(body?.deviceKind);
                    const requestedAuthority = body?.authority;
                    if (requestedAuthority !== undefined && requestedAuthority !== 'control' && requestedAuthority !== 'observe') {
                        writeJsonError(res, 400, 'authority must be control or observe');
                        return;
                    }
                    const deviceAuthority = deviceKind === 'browser' && requestedAuthority === 'observe' ? 'observe' : 'control';
                    if (claim.length < 43 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineSlug) || deviceKind === undefined) {
                        writeJsonError(res, 400, 'claim, machineSlug and deviceKind are required');
                        return;
                    }
                    if (!(await machineAuthority?.isMachineAllowed(machineSlug))) { writeJsonError(res, 403, 'machine is revoked or expired'); return; }
                    const session = await localPairing.createSession({ claim, machineSlug, deviceKind, authority: deviceAuthority });
                    writeJson(res, 201, { pair_id: session.pairId, expires_in: session.expiresIn });
                    return;
                }
                if (req.method === 'POST' && codeMatch?.[1] !== undefined) {
                    const authority = await resolveAuthority(req);
                    if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'pair code publication requires owner or machine authority'); return; }
                    const sessionSlug = await localPairing.sessionMachineSlug(codeMatch[1]);
                    if (sessionSlug !== undefined && !(await machineAuthority?.isMachineAllowed(sessionSlug))) { writeJsonError(res, 403, 'machine is revoked or expired'); return; }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const codeHash = typeof body?.code_hash === 'string' ? body.code_hash : '';
                    const payload = typeof body?.payload === 'string' ? body.payload : '';
                    if (!/^[A-Za-z0-9_-]{43}$/.test(codeHash) || payload === ''
                        || !(await localPairing.publishCode(codeMatch[1], authority.machine?.slug, { codeHash, payload }))) {
                        writeJsonError(res, 400, 'pairing_code_invalid');
                        return;
                    }
                    writeJson(res, 200, { ok: true });
                    return;
                }
                if (req.method === 'POST' && claimMatch?.[1] !== undefined) {
                    const sessionSlug = await localPairing.sessionMachineSlug(claimMatch[1]);
                    if (sessionSlug !== undefined && !(await machineAuthority?.isMachineAllowed(sessionSlug))) { writeJsonError(res, 403, 'machine is revoked or expired'); return; }
                    if (rateLimited(`claim:${clientIp(req, config.trustProxy)}`, 20, 60_000, Date.now())) {
                        writeJsonError(res, 429, 'too many requests');
                        return;
                    }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const claim = typeof body?.claim === 'string' ? body.claim : '';
                    const devicePublicKey = typeof body?.device_public_key === 'string' ? body.device_public_key : '';
                    const deviceName = typeof body?.device_name === 'string' ? body.device_name.slice(0, 120) : '';
                    const mailbox = typeof body?.mailbox === 'string' ? body.mailbox : '';
                    const deviceKind = body?.device_kind === 'browser' ? 'browser' : 'native';
                    const browserExpiresAt = deviceKind === 'browser' ? Date.now() + 8 * 60 * 60_000 : undefined;
                    if (claim === '' || devicePublicKey === '' || deviceName === '' || mailbox === '' || mailbox.length > 16 * 1024) {
                        writeJsonError(res, 400, 'claim, device_public_key, device_name and mailbox are required');
                        return;
                    }
                    const result = await localPairing.claim(claimMatch[1], {
                        claim, devicePublicKey, deviceName, deviceKind, mailbox,
                        ...(browserExpiresAt === undefined ? {} : { expiresAt: browserExpiresAt }),
                    });
                    if (result.state === 'issued') {
                        writeJson(res, 201, { device_id: result.deviceId, device_credential: result.credential });
                    } else {
                        writeJsonError(res, pairClaimStatus(result.state), result.state);
                    }
                    return;
                }
                if (req.method === 'GET' && pollMatch?.[1] !== undefined) {
                    const authority = await resolveAuthority(req);
                    if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'pair polling requires owner or machine authority'); return; }
                    const sessionSlug = await localPairing.sessionMachineSlug(pollMatch[1]);
                    if (sessionSlug !== undefined && !(await machineAuthority?.isMachineAllowed(sessionSlug))) { writeJsonError(res, 403, 'machine is revoked or expired'); return; }
                    writeJson(res, 200, await localPairing.poll(pollMatch[1], authority.machine?.slug));
                    return;
                }
                if (req.method === 'POST' && completeMatch?.[1] !== undefined) {
                    const presented = extractBearerToken(req);
                    const device = presented === undefined ? undefined : await localPairing.resolveDeviceCredential(presented);
                    if (device === undefined) { writeJsonError(res, 403, 'pairing completion requires a paired device credential'); return; }
                    if (!(await localPairing.acknowledgeGrant(completeMatch[1], device.deviceId))) { writeJsonError(res, 409, 'pairing_not_durable'); return; }
                    writeJson(res, 200, { ok: true });
                    return;
                }
                if (grantMatch?.[1] !== undefined) {
                    if (req.method === 'POST') {
                        const authority = await resolveAuthority(req);
                        if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'grant upload requires owner or machine authority'); return; }
                        const sessionSlug = await localPairing.sessionMachineSlug(grantMatch[1]);
                        if (sessionSlug !== undefined && !(await machineAuthority?.isMachineAllowed(sessionSlug))) { writeJsonError(res, 403, 'machine is revoked or expired'); return; }
                        const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                        const grant = typeof body?.grant === 'string' ? body.grant : '';
                        if (grant === '' || grant.length > 16 * 1024) { writeJsonError(res, 400, 'grant is required'); return; }
                        if (!(await localPairing.uploadGrant(grantMatch[1], authority.machine?.slug, grant))) { writeJsonError(res, 404, 'pair_session_unavailable'); return; }
                        writeJson(res, 200, { ok: true });
                        return;
                    }
                    if (req.method === 'GET') {
                        const presented = extractBearerToken(req);
                        const device = presented === undefined ? undefined : await localPairing.resolveDeviceCredential(presented);
                        if (device === undefined) { writeJsonError(res, 403, 'grant download requires a paired device credential'); return; }
                        if (!(await machineAuthority?.isMachineAllowed(device.machineSlug))) { writeJsonError(res, 403, 'machine is revoked or expired'); return; }
                        const grant = await localPairing.fetchGrant(grantMatch[1], device.deviceId);
                        if (grant === undefined) { writeJsonError(res, 404, 'grant_not_available'); return; }
                        writeJson(res, 200, { grant });
                        return;
                    }
                }
                writeJsonError(res, 404, 'not_found');
                return;
            }
            // Peer authority is target-machine scoped. Peer credentials can
            // route opaque envelopes, but cannot mint terminal/preview/stream tickets.
            if (config.localAuthority && localPairing !== undefined && req.method === 'POST'
                && url.pathname === '/v1/selfhost/peers') {
                const authority = await resolveAuthority(req);
                if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'peer issuance requires owner or target machine authority'); return; }
                const requestedSlug = url.searchParams.get('machine')?.trim() ?? '';
                if (authority.machine !== undefined && requestedSlug !== '' && requestedSlug !== authority.machine.slug) {
                    writeJsonError(res, 403, 'machine credential cannot issue for another machine'); return;
                }
                const machineSlug = authority.machine?.slug ?? requestedSlug;
                if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineSlug)) { writeJsonError(res, 400, 'machine is required'); return; }
                const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                const publicKey = typeof body?.device_public_key === 'string' ? body.device_public_key : '';
                const name = typeof body?.device_name === 'string' ? body.device_name.trim() : '';
                const capabilities = body?.capabilities;
                const peerMachineId = typeof body?.peer_machine_id === 'string' && body.peer_machine_id !== '' ? body.peer_machine_id.slice(0, 128) : undefined;
                const expiresAt = body?.credential_expires_at;
                const refreshAfter = body?.refresh_after;
                const authorityId = typeof body?.authority_id === 'string' && body.authority_id !== '' ? body.authority_id.slice(0, 256) : undefined;
                if (!isValidPublicKey(publicKey) || name === '' || !isPeerCapabilities(capabilities)
                    || expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
                    || refreshAfter !== undefined && (typeof refreshAfter !== 'number' || !Number.isFinite(refreshAfter))) {
                    writeJsonError(res, 400, 'device_public_key, device_name and valid peer capabilities are required');
                    return;
                }
                const issued = await localPairing.issuePeer({
                    machineSlug,
                    publicKey,
                    name,
                    capabilities,
                    ...(peerMachineId === undefined ? {} : { peerMachineId }),
                    ...(expiresAt === undefined ? {} : { expiresAt }),
                    ...(refreshAfter === undefined ? {} : { refreshAfter }),
                    ...(authorityId === undefined ? {} : { authorityId }),
                });
                if (issued === undefined) { writeJsonError(res, 409, 'peer_already_authorized'); return; }
                writeJson(res, 201, {
                    device_id: issued.deviceId,
                    device_credential: issued.credential,
                    credential_version: issued.credentialVersion,
                });
                return;
            }
            if (config.localAuthority && localPairing !== undefined && req.method === 'GET'
                && url.pathname === '/v1/selfhost/peers') {
                const authority = await resolveAuthority(req);
                if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'peer listing requires owner or machine authority'); return; }
                const requestedSlug = url.searchParams.get('machine')?.trim() ?? '';
                if (authority.machine !== undefined && requestedSlug !== '' && requestedSlug !== authority.machine.slug) {
                    writeJsonError(res, 403, 'machine credential cannot list another machine'); return;
                }
                const machineSlug = authority.machine?.slug ?? requestedSlug;
                if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineSlug)) { writeJsonError(res, 400, 'machine is required'); return; }
                writeJson(res, 200, { peers: await localPairing.listPeers(machineSlug) });
                return;
            }
            const peerAuthorityMatch = /^\/v1\/selfhost\/peers\/([^/]+)(?:\/(grant|rotate))?$/.exec(url.pathname);
            if (config.localAuthority && localPairing !== undefined && peerAuthorityMatch?.[1] !== undefined) {
                const deviceId = decodeURIComponent(peerAuthorityMatch[1]);
                const action = peerAuthorityMatch[2];
                if (req.method === 'POST' && action === 'grant') {
                    const authority = await resolveAuthority(req);
                    if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'peer grant refresh requires owner or target machine authority'); return; }
                    const requestedSlug = url.searchParams.get('machine')?.trim() ?? '';
                    if (authority.machine !== undefined && requestedSlug !== '' && requestedSlug !== authority.machine.slug) {
                        writeJsonError(res, 403, 'machine credential cannot refresh another machine'); return;
                    }
                    const machineSlug = authority.machine?.slug ?? requestedSlug;
                    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineSlug)) { writeJsonError(res, 400, 'machine is required'); return; }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const grant = typeof body?.grant === 'string' ? body.grant : '';
                    const keyVersion = body?.key_version;
                    if (grant === '' || grant.length > 16 * 1024 || typeof keyVersion !== 'number'
                        || !(await localPairing.storePeerGrant(deviceId, machineSlug, grant, keyVersion))) {
                        writeJsonError(res, 409, 'peer_grant_invalid'); return;
                    }
                    closePeers({ accountId: `local:${machineSlug}`, deviceId }, 'peer grant refreshed');
                    writeJson(res, 200, { ok: true, key_version: keyVersion });
                    return;
                }
                if (req.method === 'POST' && action === 'rotate') {
                    const authority = await resolveAuthority(req);
                    if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'peer credential rotation requires owner or target machine authority'); return; }
                    const requestedSlug = url.searchParams.get('machine')?.trim() ?? '';
                    if (authority.machine !== undefined && requestedSlug !== '' && requestedSlug !== authority.machine.slug) {
                        writeJsonError(res, 403, 'machine credential cannot rotate another machine'); return;
                    }
                    const machineSlug = authority.machine?.slug ?? requestedSlug;
                    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(machineSlug)) { writeJsonError(res, 400, 'machine is required'); return; }
                    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                    const expiresAt = body?.credential_expires_at;
                    const refreshAfter = body?.refresh_after;
                    if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
                        || refreshAfter !== undefined && (typeof refreshAfter !== 'number' || !Number.isFinite(refreshAfter))) {
                        writeJsonError(res, 400, 'invalid peer credential lifetime'); return;
                    }
                    const rotated = await localPairing.rotatePeerCredential(deviceId, machineSlug, {
                        ...(expiresAt === undefined ? {} : { expiresAt }),
                        ...(refreshAfter === undefined ? {} : { refreshAfter }),
                        ...(typeof body?.authority_id === 'string' && body.authority_id !== '' ? { authorityId: body.authority_id.slice(0, 256) } : {}),
                    });
                    if (rotated === undefined) { writeJsonError(res, 404, 'peer_not_found'); return; }
                    revokePeers({ accountId: `local:${machineSlug}`, deviceId });
                    writeJson(res, 200, {
                        device_credential: rotated.credential,
                        credential_version: rotated.credentialVersion,
                    });
                    return;
                }
                if (req.method === 'DELETE' && action === undefined) {
                    const authority = await resolveAuthority(req);
                    if (!authority.owner && authority.machine === undefined) { writeJsonError(res, 403, 'peer revocation requires owner or target machine authority'); return; }
                    const revoked = await localPairing.revokeDevice(deviceId, authority.machine?.slug, 'peer');
                    if (revoked === undefined) { writeJsonError(res, 404, 'peer_not_found'); return; }
                    revokePeers({ accountId: `local:${revoked.machineSlug}`, deviceId });
                    writeJson(res, 200, { ok: true });
                    return;
                }
            }
            if (config.localAuthority && localPairing !== undefined && req.method === 'GET'
                && url.pathname === '/v1/selfhost/devices') {
                const authority = await resolveAuthority(req);
                if (!authority.owner && authority.machine === undefined) {
                    writeJsonError(res, 403, 'device listing requires owner or machine authority');
                    return;
                }
                const requestedSlug = url.searchParams.get('machine')?.trim() ?? '';
                if (authority.machine !== undefined && requestedSlug !== authority.machine.slug) { writeJsonError(res, 403, 'machine credential cannot list another machine'); return; }
                const machineSlug = authority.machine?.slug ?? requestedSlug;
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
                if (!(await machineAuthority?.isMachineAllowed(machineSlug))) { writeJsonError(res, 403, 'machine is revoked or expired'); return; }
                const grant = await localPairing.fetchCurrentGrant(device.deviceId, machineSlug);
                if (grant === undefined) { writeJsonError(res, 404, 'grant_not_available'); return; }
                writeJson(res, 200, { grant });
                return;
            }
            const rotatedGrantsMatch = /^\/v1\/selfhost\/machines\/([^/]+)\/grants$/.exec(url.pathname);
            if (config.localAuthority && localPairing !== undefined && req.method === 'POST' && rotatedGrantsMatch?.[1] !== undefined) {
                const authority = await resolveAuthority(req);
                if (!authority.owner && authority.machine === undefined) {
                    writeJsonError(res, 403, 'grant rotation requires owner or machine authority');
                    return;
                }
                const requestedSlug = decodeURIComponent(rotatedGrantsMatch[1]);
                if (authority.machine !== undefined && requestedSlug !== authority.machine.slug) { writeJsonError(res, 403, 'machine credential cannot rotate another machine'); return; }
                const machineSlug = authority.machine?.slug ?? requestedSlug;
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
                    || !(await localPairing.storeCurrentGrants(machineSlug, keyVersion, grants))) {
                    writeJsonError(res, 409, 'rotation_grants_invalid');
                    return;
                }
                // Force every remaining peer to reconnect and refresh the new
                // grant. This also reconnects the host after its local key swap.
                closePeers({ accountId: `local:${machineSlug}`, machineSlug }, 'keys rotated');
                writeJson(res, 200, { ok: true, key_version: keyVersion });
                return;
            }
            // Device revocation: mint-secret authed, immediate.
            if (config.localAuthority && localPairing !== undefined && req.method === 'DELETE'
                && url.pathname.startsWith('/v1/selfhost/devices/')) {
                const authority = await resolveAuthority(req);
                if (!authority.owner && authority.machine === undefined) {
                    writeJsonError(res, 403, 'device revocation requires owner or machine authority');
                    return;
                }
                const deviceId = decodeURIComponent(url.pathname.slice('/v1/selfhost/devices/'.length));
                const revoked = await localPairing.revokeDevice(deviceId, authority.machine?.slug);
                if (revoked === undefined) {
                    writeJsonError(res, 404, 'device_not_found');
                    return;
                }
                revokePeers({ accountId: `local:${revoked.machineSlug}`, deviceId });
                await push.removeExpoDevice(`local:${revoked.machineSlug}`, deviceId);
                writeJson(res, 200, { ok: true });
                return;
            }
            if (config.localAuthority && localPairing !== undefined && (req.method === 'POST' || req.method === 'DELETE')
                && url.pathname === '/v1/push/expo-subscribe') {
                const presented = extractBearerToken(req);
                const device = presented === undefined ? undefined : await localPairing.resolveDeviceCredential(presented);
                if (device === undefined || device.deviceKind === 'peer') { writeJsonError(res, 403, 'invalid device credential'); return; }
                if (req.method === 'POST') {
                    const body = (await readJsonBody(req).catch(() => undefined)) as { token?: unknown; level?: unknown } | undefined;
                    if (!isExpoPushToken(body?.token)) { writeJsonError(res, 400, 'invalid Expo push token'); return; }
                    const level = body.level === undefined ? 'important' : parseLifecycleNotificationLevel(body.level);
                    if (level === undefined) { writeJsonError(res, 400, 'invalid lifecycle notification level'); return; }
                    await push.subscribeExpo(`local:${device.machineSlug}`, body.token, level, device.deviceId);
                } else {
                    await push.removeExpoDevice(`local:${device.machineSlug}`, device.deviceId);
                }
                writeJson(res, 200, { ok: true });
                return;
            }
            if (config.localAuthority && machineAuthority !== undefined && req.method === 'POST'
                && url.pathname === '/v1/push/notify') {
                const presented = extractBearerToken(req);
                const machine = presented === undefined ? undefined : await machineAuthority.resolveCredential(presented);
                const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
                if (machine === undefined) { writeJsonError(res, 403, 'invalid machine credential'); return; }
                const notification = body === undefined ? undefined : parsePushNotification(body);
                if (body?.machineId !== machine.slug || typeof body.sessionId !== 'string' || body.sessionId === ''
                    || body.sessionId.length > 256 || notification === undefined) {
                    writeJsonError(res, 400, 'invalid push payload');
                    return;
                }
                const outcome = await push.notify(`local:${machine.slug}`, {
                    ...notification,
                    sessionId: body.sessionId,
                    machineId: machine.slug,
                });
                writeJson(res, 200, { ok: true, ...outcome });
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
        const url = new URL(req.url ?? '/', 'http://localhost');
        const relayTransport = !url.pathname.endsWith('/preview')
            && !url.pathname.endsWith('/terminal') && !url.pathname.endsWith('/stream');
        const ignoreAuthError = (): void => undefined;
        const discardRejectedMessage = (): void => undefined;
        const rejectConnection = (code: number, reason: string): void => {
            if (relayTransport) socket.on('message', discardRejectedMessage);
            socket.close(code, reason);
            if (relayTransport) socket.resume();
        };
        if (relayTransport) {
            socket.pause();
            socket.on('error', ignoreAuthError);
        }
        void (async () => {
        if (!config.developmentApi
            && rateLimited(`ws:${clientIp(req, config.trustProxy)}`, 60, 60_000, Date.now())) {
            rejectConnection(1008, 'too many requests');
            return;
        }
        if (!webSocketOriginAllowed(req, config)) {
            rejectConnection(1008, 'origin not allowed');
            return;
        }
        const identity = await admitSocketFromUrl({
            url,
            authMode,
            remoteAddress: req.socket.remoteAddress,
            consumeTicket: options.consumeTicket
                ?? (async (ticket) => {
                    const consumed = await (localTickets?.consume(ticket) ?? Promise.resolve(undefined));
                    if (consumed?.machineCredentialId !== undefined
                        && !(await machineAuthority?.isCredentialActive(consumed.machineCredentialId))) return undefined;
                    if (consumed !== undefined && !(await machineAuthority?.isMachineAllowed(consumed.machineSlug))) return undefined;
                    return consumed;
                }),
        });

        if (!identity) {
            process.stderr.write('rejected unauthorized WebSocket\n');
            rejectConnection(1008, 'unauthorized');
            return;
        }
        if (config.localAuthority && localPairing !== undefined && admittedByTicket(identity)
            && identity.deviceId !== undefined && !(await localPairing.isDeviceActive(identity.deviceId, identity.credentialVersion))) {
            rejectConnection(1008, 'revoked');
            return;
        }
        const transport = websocketTransport(url.pathname);
        if (admittedByTicket(identity) && identity.transport !== transport) {
            rejectConnection(1008, 'ticket scope mismatch');
            return;
        }
        if (config.e2eeMode === 'on' && transport === 'preview'
            && identity.role === 'client' && url.searchParams.get('bridge') !== '1') {
            rejectConnection(1008, 'encrypted preview requires the native bridge');
            return;
        }
        if (socket.readyState !== socket.OPEN) {
            if (relayTransport) socket.off('error', ignoreAuthError);
            return;
        }
        const authenticatedSocket = { socket, identity };
        authenticatedSockets.add(authenticatedSocket);
        const credentialTimer = admittedByTicket(identity) && (identity.machineCredentialId !== undefined || identity.deviceId !== undefined)
            ? setInterval(() => {
                void (async () => {
                    const machineActive = identity.machineCredentialId === undefined
                        || await machineAuthority?.isCredentialActive(identity.machineCredentialId) === true;
                    const deviceActive = identity.deviceId === undefined
                        || await localPairing?.isDeviceActive(identity.deviceId, identity.credentialVersion) === true;
                    const machineSlug = identity.machineIds.values().next().value;
                    const parentActive = typeof machineSlug !== 'string' || await machineAuthority?.isMachineAllowed(machineSlug) === true;
                    if (!machineActive || !deviceActive || !parentActive) socket.close(1008, 'credential expired or revoked');
                })();
            }, 60_000)
            : undefined;
        credentialTimer?.unref();
        socket.once('close', () => {
            authenticatedSockets.delete(authenticatedSocket);
            if (credentialTimer !== undefined) clearInterval(credentialTimer);
        });

        // Preview sockets carry raw tunnel bytes, not envelopes. They never join
        // the peer table, so nothing downstream can route a session envelope at
        // one, and their traffic never reaches the replay log or offline buffer.
        // endsWith, not ===: a relay behind a path-prefixed proxy (wss://host/relay)
        // sees /relay/preview.
        if (url.pathname.endsWith('/preview')) {
            const { channel, machineId } = tunnelAdmission(identity, url);
            if (!channel || !machineId || !identity.machineIds.has(machineId)) {
                socket.close(1008, 'preview requires channel and an authorized machineId');
                return;
            }
            const key = tunnelKey(identity.accountId, machineId, channel);
            if (identity.role === 'machine') {
                previews.joinMachine(key, socket);
            } else if (url.searchParams.get('bridge') === '1') {
                previews.bridgeClient(key, socket);
            } else {
                // Same interface the relay itself is reachable on, so a preview
                // reaches exactly as far as the session link does.
                void previews.joinClient(key, socket, config.host, req.socket.remoteAddress);
            }
            return;
        }

        if (url.pathname.endsWith('/terminal') || url.pathname.endsWith('/stream')) {
            const isStream = url.pathname.endsWith('/stream');
            const { channel, machineId } = tunnelAdmission(identity, url);
            if (!channel || !machineId || !identity.machineIds.has(machineId)) {
                socket.close(1008, `${isStream ? 'stream' : 'terminal'} requires channel and an authorized machineId`);
                return;
            }
            const key = tunnelKey(identity.accountId, machineId, channel);
            const channels = isStream ? realtimeStreams : terminals;
            const accept = opaqueTunnelAccept(config.e2eeMode === 'on', isStream);
            if (identity.role === 'machine') {
                channels.joinMachine(key, socket, accept);
            } else {
                void channels.joinClient(key, socket, accept);
            }
            return;
        }

        if (socket.readyState !== socket.OPEN) {
            authenticatedSockets.delete(authenticatedSocket);
            if (relayTransport) socket.off('error', ignoreAuthError);
            return;
        }
        const lastSeenSeq = parseLastSeq(url);
        const peer: ConnectedPeer = {
            socket,
            identity,
            accountId: identity.accountId,
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
                { ...(pushWebhook === undefined ? {} : { pushWebhook }), onPeerRoute: recordPeerRoute },
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
        if (relayTransport) {
            socket.off('error', ignoreAuthError);
            if (socket.readyState !== socket.OPEN) {
                detach();
                return;
            }
            socket.resume();
        }
        })().catch(() => {
            process.stderr.write('WebSocket authentication failed\n');
            rejectConnection(1011, 'authentication failed');
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
                name: config.mdnsName ?? `muxr-${hostname()}`,
                type: 'muxr',
                protocol: 'tcp',
                port: listeningPort,
                txt: {
                    v: '2',
                    ...(config.mdnsMachineId === undefined ? {} : { machine: config.mdnsMachineId }),
                    ...(config.mdnsRelayUrl === undefined ? {} : { relay: config.mdnsRelayUrl }),
                    ...(config.mdnsConnectionMode === undefined ? {} : { mode: config.mdnsConnectionMode }),
                },
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
            (peer) => admittedByTicket(peer.identity) && peer.identity.role === 'client' && peer.identity.accountId === accountId,
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

function websocketTransport(pathname: string): 'preview' | 'terminal' | 'stream' | 'relay' {
    if (pathname.endsWith('/preview')) return 'preview';
    if (pathname.endsWith('/terminal')) return 'terminal';
    if (pathname.endsWith('/stream')) return 'stream';
    return 'relay';
}

function tunnelAdmission(identity: PeerIdentity, url: URL): { channel?: string; machineId?: string } {
    if (admittedByTicket(identity)) {
        const machineId = [...identity.machineIds][0];
        return {
            ...(identity.channel === undefined ? {} : { channel: identity.channel }),
            ...(machineId === undefined ? {} : { machineId }),
        };
    }
    const channel = url.searchParams.get('channel')?.trim();
    const machineId = url.searchParams.get('machineId')?.trim();
    return {
        ...(channel === undefined || channel === '' ? {} : { channel }),
        ...(machineId === undefined || machineId === '' ? {} : { machineId }),
    };
}

function tunnelKey(accountId: string, machineId: string, channel: string): string {
    return `${accountId.length}:${accountId}${machineId.length}:${machineId}${channel}`;
}

function opaqueTunnelAccept(e2eeOn: boolean, isStream: boolean): ((raw: string) => boolean) | undefined {
    if (!e2eeOn) return undefined;
    return isStream ? isOpaqueV2StreamFrame : isOpaqueV2TerminalFrame;
}

function readMachineSlug(body: Record<string, unknown> | undefined): string {
    if (typeof body?.machineSlug === 'string') return body.machineSlug.trim();
    if (typeof body?.machineId === 'string') return body.machineId.trim();
    if (typeof body?.machine_id === 'string') return body.machine_id.trim();
    return '';
}

function readPairingDeviceKind(value: unknown): 'browser' | 'native' | undefined {
    if (value === 'browser' || value === 'native') return value;
    return undefined;
}

function enrollmentClaimStatus(state: string): number {
    if (state === 'expired') return 400;
    if (state === 'already_claimed') return 409;
    return 403;
}

function pairingCodeError(state: string): { status: number; error: string } {
    if (state === 'expired') return { status: 410, error: 'pairing_code_expired' };
    return { status: 404, error: 'invalid_pairing_code' };
}

function pairClaimStatus(state: string): number {
    if (state === 'invalid_claim' || state === 'wrong_device_kind') return 403;
    if (state === 'expired') return 400;
    return 409;
}
