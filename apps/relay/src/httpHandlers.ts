import type { IncomingMessage, ServerResponse } from 'node:http';
import { get as httpGet } from 'node:http';
import type { RelayE2eeMode } from './config.js';
import { extractBearerToken, isValidPublicKey, pairMachine, approveMachinePairing, type PairingRequests, type MachineRegistry } from './admission/index.js';
import type { OfflineBuffer, PeerTable, ReplayLog } from './routing/index.js';
import { parsePushNotification, type PushService } from './push/index.js';

export interface PushActionOutcome {
    ok: boolean;
    /** HTTP status to answer with when not ok. */
    status: number;
    data?: unknown;
    error?: string;
}

export interface HttpContext {
    pairing: PairingRequests;
    registry: MachineRegistry;
    peers: PeerTable;
    offline: OfflineBuffer;
    replay: ReplayLog;
    startedAt: number;
    e2eeMode: RelayE2eeMode;
    droppedCount: () => number;
    push: PushService;
    /** Send a synthetic client request to a machine and await its result. */
    pushAction: (input: { machineId: string; sessionId: string; answer: 'y' | 'n' }) => Promise<PushActionOutcome>;
    /** Generic synthetic request (attachment downloads); same machine link as pushAction. */
    machineRequest: (
        input: {
            machineId: string;
            sessionId?: string;
            timeoutMs?: number;
        } & (
            | { type: 'session.answer'; params: { sessionId: string; answer: 'y' | 'n' } }
            | { type: 'attachment.fetch'; params: { sessionId: string; attachmentId: string } }
            | { type: 'attachment.prepare'; params: { sessionId: string; attachmentId: string } }
        ),
    ) => Promise<PushActionOutcome>;
    /** sessionId -> owning machineId, learned from envelope headers. */
    sessionOwnerOf: (sessionId: string) => string | undefined;
    /** The host's loopback attachment server (streams the actual bytes). */
    hostDownloadBaseUrl: string;
}

const HTTP_BODY_LIMIT = 256 * 1024;

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > HTTP_BODY_LIMIT) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(Buffer.from(chunk));
        });
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

export function writeJsonError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
}

export function isExpoPushToken(value: unknown): value is string {
    return typeof value === 'string' && /^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/.test(value);
}

function isPushSubscription(
    value: unknown,
): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
    if (typeof value !== 'object' || value === null) return false;
    const sub = value as { endpoint?: unknown; keys?: unknown };
    if (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return false;
    const keys = sub.keys as { p256dh?: unknown; auth?: unknown } | undefined;
    if (typeof keys !== 'object' || keys === null) return false;
    return (
        typeof keys.p256dh === 'string' &&
        keys.p256dh.length > 0 &&
        typeof keys.auth === 'string' &&
        keys.auth.length > 0
    );
}

export async function handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: HttpContext,
): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
        const online = ctx.peers.onlineMachineIds();
        writeJson(res, 200, {
            ok: true,
            e2eeMode: ctx.e2eeMode,
            registeredMachines: ctx.registry.registeredMachineCount(),
            onlineMachines: online.size,
            offlineMachines: Math.max(0, ctx.registry.registeredMachineCount() - online.size),
        });
        return;
    }

    if (req.method === 'GET' && path === '/metrics') {
        const peerCounts = ctx.peers.counts();
        const online = ctx.peers.onlineMachineIds();
        const registered = ctx.registry.registeredMachineCount();
        writeJson(res, 200, {
            uptimeMs: Date.now() - ctx.startedAt,
            e2eeMode: ctx.e2eeMode,
            connectedMachines: peerCounts.machines,
            connectedClients: peerCounts.clients,
            connectedPeers: peerCounts.total,
            registeredMachines: registered,
            onlineMachines: online.size,
            offlineMachines: Math.max(0, registered - online.size),
            bufferedFrames: ctx.offline.totalBuffered(),
            bufferedDropped: ctx.droppedCount(),
            replayStored: ctx.replay.totalStored(),
        });
        return;
    }

    // Big attachment downloads as a plain HTTPS GET: the browser's own download
    // manager streams it (progress bar, background-safe) instead of the phone
    // JSON-parsing a 300MB ws frame. Token rides the query string because anchor
    // downloads cannot set headers -- same posture as the ws auth query token.
    if (req.method === 'GET' && path === '/v1/attachment-download') {
        const machineId = url.searchParams.get('machineId') ?? '';
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const attachmentId = url.searchParams.get('attachmentId') ?? '';
        const token = url.searchParams.get('token') ?? '';
        if (machineId === '' || sessionId === '' || attachmentId === '' || token === '') {
            writeJson(res, 400, { error: 'machineId, sessionId, attachmentId, token required' });
            return;
        }
        if (ctx.registry.resolveClientMachines(token, [machineId]) === undefined) {
            writeJson(res, 401, { error: 'unauthorized' });
            return;
        }
        if (ctx.e2eeMode === 'on') {
            // The relay cannot synthesize requests into an E2EE machine link.
            // Attachments flow over the encrypted envelope channel instead.
            writeJson(res, 410, { error: 'attachment-download is unavailable with E2EE on; use the encrypted channel' });
            return;
        }
        const outcome = await ctx.machineRequest({
            machineId,
            sessionId,
            type: 'attachment.prepare',
            params: { sessionId, attachmentId },
            timeoutMs: 30_000,
        });
        if (!outcome.ok) {
            writeJson(res, outcome.status, { error: outcome.error ?? 'machine request failed' });
            return;
        }
        const found = outcome.data as { token?: unknown; name?: unknown; mimeType?: unknown } | null;
        if (found === null || found === undefined || typeof found.token !== 'string') {
            writeJson(res, 404, { error: 'attachment not found' });
            return;
        }
        // Pipe the original bytes from the host's loopback server. The file
        // streams host -> relay -> phone; nothing becomes a giant JSON frame.
        // Range headers flow both ways so Chrome can parallelize and resume.
        const upstream = await new Promise<IncomingMessage | null>((resolve) => {
            const request = httpGet(
                `${ctx.hostDownloadBaseUrl}/attachment/${found.token}`,
                { headers: req.headers.range === undefined ? {} : { range: req.headers.range } },
                (upstreamRes) => {
                    request.setTimeout(0); // headers are in; a slow phone may stream for minutes
                    resolve(upstreamRes);
                },
            );
            request.on('error', () => resolve(null));
            // Guards a hung connect only: once bytes are streaming the socket
            // must not be killed for taking as long as a slow phone needs.
            request.setTimeout(30_000, () => {
                request.destroy();
                resolve(null);
            });
        });
        if (upstream === null || (upstream.statusCode !== 200 && upstream.statusCode !== 206)) {
            writeJson(res, 502, { error: 'host download server unreachable' });
            return;
        }
        res.writeHead(upstream.statusCode, {
            'content-type': attachmentContentType(found.mimeType),
            ...(upstream.headers['content-length'] === undefined
                ? {}
                : { 'content-length': upstream.headers['content-length'] }),
            'content-disposition':
                upstream.headers['content-disposition'] ?? `attachment; filename="attachment"`,
            ...(upstream.headers['content-range'] === undefined
                ? {}
                : { 'content-range': upstream.headers['content-range'] }),
            'accept-ranges': 'bytes',
        });
        upstream.pipe(res);
        return;
    }

    // Device pairing. The request endpoint is create-or-poll, matching the client.
    if (req.method === 'POST' && path === '/v1/auth/account/request') {
        let body: { publicKey?: unknown };
        try {
            body = (await readJsonBody(req)) as { publicKey?: unknown };
        } catch {
            writeJson(res, 400, { error: 'invalid json body' });
            return;
        }
        if (!isValidPublicKey(body.publicKey)) {
            writeJson(res, 400, { error: 'publicKey must be 32 bytes, base64' });
            return;
        }
        const paired = pairMachine(ctx.pairing, { publicKey: body.publicKey }, isValidPublicKey);
        if (!paired.ok) {
            writeJson(res, 429, { error: 'too many pending pairing requests' });
            return;
        }
        writeJson(res, 200, paired.state);
        return;
    }

    if (req.method === 'POST' && path === '/v1/auth/account/response') {
        const token = extractBearerToken(req);
        if (!token) {
            writeJson(res, 401, { error: 'account token required' });
            return;
        }
        const account = ctx.registry.findAccountByToken(token);
        if (!account) {
            writeJson(res, 403, { error: 'invalid account token' });
            return;
        }
        let body: { publicKey?: unknown; response?: unknown };
        try {
            body = (await readJsonBody(req)) as { publicKey?: unknown; response?: unknown };
        } catch {
            writeJson(res, 400, { error: 'invalid json body' });
            return;
        }
        if (!isValidPublicKey(body.publicKey) || typeof body.response !== 'string' || body.response.length === 0) {
            writeJson(res, 400, { error: 'publicKey and sealed response required' });
            return;
        }
        const approved = approveMachinePairing(
            ctx.pairing,
            { publicKey: body.publicKey, sealedResponse: body.response, accountToken: account.token },
            isValidPublicKey,
        );
        if (!approved.ok) {
            writeJson(res, 404, { error: 'no pending pairing request' });
            return;
        }
        writeJson(res, 200, { ok: true });
        return;
    }

    if (req.method === 'POST' && path === '/v1/accounts') {
        const created = await ctx.registry.createAccount();
        writeJson(res, 201, created);
        return;
    }

    if (req.method === 'POST' && path === '/v1/machines') {
        const token = extractBearerToken(req);
        if (!token) {
            writeJson(res, 401, { error: 'account token required' });
            return;
        }
        let body: { machineId?: string; name?: string };
        try {
            body = (await readJsonBody(req)) as { machineId?: string; name?: string };
        } catch {
            writeJson(res, 400, { error: 'invalid json body' });
            return;
        }
        const registered = await ctx.registry.registerMachine(token, body);
        if (!registered) {
            writeJson(res, 403, { error: 'invalid account token or duplicate machineId' });
            return;
        }
        writeJson(res, 201, registered);
        return;
    }

    if (req.method === 'GET' && path === '/v1/machines') {
        const token = extractBearerToken(req);
        if (!token) {
            writeJson(res, 401, { error: 'account token required' });
            return;
        }
        const machines = ctx.registry.listMachines(token, ctx.peers.onlineMachineIds());
        if (!machines) {
            writeJson(res, 403, { error: 'invalid account token' });
            return;
        }
        writeJson(res, 200, { machines, e2eeMode: ctx.e2eeMode });
        return;
    }

    if (req.method === 'GET' && path === '/v1/push/vapid-public') {
        const token = extractBearerToken(req);
        if (!token) {
            writeJson(res, 401, { error: 'account token required' });
            return;
        }
        if (!ctx.registry.findAccountByToken(token)) {
            writeJson(res, 403, { error: 'invalid account token' });
            return;
        }
        writeJson(res, 200, { publicKey: ctx.push.publicKey() });
        return;
    }

    if (req.method === 'POST' && path === '/v1/push/subscribe') {
        const token = extractBearerToken(req);
        if (!token) {
            writeJson(res, 401, { error: 'account token required' });
            return;
        }
        const account = ctx.registry.findAccountByToken(token);
        if (!account) {
            writeJson(res, 403, { error: 'invalid account token' });
            return;
        }
        let body: { subscription?: unknown };
        try {
            body = (await readJsonBody(req)) as { subscription?: unknown };
        } catch {
            writeJson(res, 400, { error: 'invalid json body' });
            return;
        }
        if (!isPushSubscription(body.subscription)) {
            writeJson(res, 400, { error: 'subscription must be {endpoint, keys: {p256dh, auth}}' });
            return;
        }
        await ctx.push.subscribe(account.accountId, body.subscription);
        writeJson(res, 200, { ok: true });
        return;
    }

    if ((req.method === 'POST' || req.method === 'DELETE') && path === '/v1/push/expo-subscribe') {
        const token = extractBearerToken(req);
        if (!token) {
            writeJson(res, 401, { error: 'account token required' });
            return;
        }
        const account = ctx.registry.findAccountByToken(token);
        if (!account) {
            writeJson(res, 403, { error: 'invalid account token' });
            return;
        }
        let body: { token?: unknown };
        try {
            body = (await readJsonBody(req)) as { token?: unknown };
        } catch {
            writeJson(res, 400, { error: 'invalid json body' });
            return;
        }
        if (!isExpoPushToken(body.token)) {
            writeJson(res, 400, { error: 'invalid Expo push token' });
            return;
        }
        if (req.method === 'POST') await ctx.push.subscribeExpo(account.accountId, body.token);
        else await ctx.push.removeExpoToken(account.accountId, body.token);
        writeJson(res, 200, { ok: true });
        return;
    }

    if (req.method === 'POST' && path === '/v1/push/notify') {
        const token = extractBearerToken(req);
        if (!token) {
            writeJson(res, 401, { error: 'machine token required' });
            return;
        }
        const machine = ctx.registry.resolveMachineToken(token);
        if (!machine) {
            writeJson(res, 403, { error: 'invalid machine token' });
            return;
        }
        let body: { machineId?: unknown; sessionId?: unknown; eventId?: unknown; kind?: unknown; reasonCode?: unknown; displayName?: unknown; taskTitle?: unknown };
        try {
            body = (await readJsonBody(req)) as typeof body;
        } catch {
            writeJson(res, 400, { error: 'invalid json body' });
            return;
        }
        if (body.machineId !== machine.machineId) {
            writeJson(res, 403, { error: 'machineId does not match token' });
            return;
        }
        if (typeof body.sessionId !== 'string' || body.sessionId === '' || body.sessionId.length > 256) {
            writeJson(res, 400, { error: 'valid sessionId is required' });
            return;
        }
        const notification = parsePushNotification(body);
        if (notification === undefined) {
            writeJson(res, 400, { error: 'invalid lifecycle notification' });
            return;
        }
        const outcome = await ctx.push.notify(machine.accountId, {
            ...notification,
            sessionId: body.sessionId,
            machineId: machine.machineId,
        });
        writeJson(res, 200, { ok: true, ...outcome });
        return;
    }

    if (req.method === 'POST' && path === '/v1/push/action') {
        const token = extractBearerToken(req);
        if (!token) {
            writeJson(res, 401, { error: 'account token required' });
            return;
        }
        const account = ctx.registry.findAccountByToken(token);
        if (!account) {
            writeJson(res, 403, { error: 'invalid account token' });
            return;
        }
        let body: { sessionId?: unknown; answer?: unknown };
        try {
            body = (await readJsonBody(req)) as { sessionId?: unknown; answer?: unknown };
        } catch {
            writeJson(res, 400, { error: 'invalid json body' });
            return;
        }
        if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            writeJson(res, 400, { error: 'sessionId is required' });
            return;
        }
        if (body.answer !== 'y' && body.answer !== 'n') {
            writeJson(res, 400, { error: 'answer must be y or n' });
            return;
        }
        const machineId = ctx.sessionOwnerOf(body.sessionId);
        if (machineId === undefined) {
            writeJson(res, 404, { error: 'unknown session' });
            return;
        }
        if (!account.machines[machineId]) {
            writeJson(res, 403, { error: 'session belongs to another account' });
            return;
        }
        if (ctx.e2eeMode === 'on') {
            // Synthetic relay-originated answers cannot cross an E2EE machine
            // link; the app answers in-band after the notification opens it.
            writeJson(res, 410, { error: 'push answers are unavailable with E2EE on; answer from the app' });
            return;
        }
        const outcome = await ctx.pushAction({ machineId, sessionId: body.sessionId, answer: body.answer });
        if (outcome.ok) {
            writeJson(res, 200, { ok: true, data: outcome.data ?? null });
            return;
        }
        writeJson(res, outcome.status, { error: outcome.error ?? 'push action failed' });
        return;
    }

    writeJson(res, 404, { error: 'not found' });
}

function attachmentContentType(mimeType: unknown): string {
    if (mimeType === 'application/vnd.android.package-archive') return 'application/octet-stream';
    if (typeof mimeType === 'string') return mimeType;
    return 'application/octet-stream';
}
