/** Self-hosted HTTP surface and byokit link relay. No muxr socket or envelope transport. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { hostname } from 'node:os';
import { openLinkRelay } from './routing/index.js';
import { MachineAuthority, enrollmentProofMessage, secureEqual } from './admission/index.js';
import { clientIp, loadRelayConfig, type RelayConfig } from './config.js';
import { readJsonBody, writeJson, writeJsonError } from './httpJson.js';
import { awaitPersistChain, readPrivateFile, writeJsonFileAtomic } from './platform/persist.js';

export async function ensureMintSecret(dataDir: string): Promise<string> {
    const file = join(dataDir, 'mint-secret');
    const existing = await readPrivateFile(file);
    if (existing !== undefined) {
        try {
            const parsed = JSON.parse(existing) as unknown;
            if (typeof parsed === 'string' && parsed !== '') return parsed;
        } catch { /* Replace a corrupt secret; the old authority cannot authenticate. */ }
    }
    const secret = randomBytes(32).toString('base64url');
    await writeJsonFileAtomic(file, secret);
    return secret;
}

export interface RelayOptions {
    port: number;
    host?: string;
    config?: Partial<RelayConfig>;
    readyCheck?: () => Promise<boolean>;
    linkPush?: { subject?: string; fetch?: typeof fetch };
}
export interface RelayHandle { port: number; close: () => Promise<void> }

function originAllowed(req: IncomingMessage, config: RelayConfig): boolean {
    const origin = req.headers.origin;
    if (origin === undefined || config.allowedOrigins.size === 0) return true;
    if (typeof origin !== 'string') return false;
    if (config.allowedOrigins.has(origin)) return true;
    const host = req.headers.host;
    return !config.publicEdge && (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1')
        && /^127\.0\.0\.1:\d+$/.test(host ?? '') && origin === `http://${host}`;
}

function jsonOrigin(req: IncomingMessage, res: ServerResponse, config: RelayConfig): boolean {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (config.publicEdge) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!originAllowed(req, config)) { writeJsonError(res, 403, 'origin not allowed'); return false; }
    if (typeof req.headers.origin === 'string' && config.allowedOrigins.has(req.headers.origin)) {
        res.setHeader('access-control-allow-origin', req.headers.origin);
        res.setHeader('access-control-allow-credentials', 'true');
        res.setHeader('access-control-allow-headers', 'authorization, content-type');
        res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('vary', 'Origin');
    }
    return true;
}

export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
    const config = loadRelayConfig({ port: options.port, ...(options.host === undefined ? {} : { host: options.host }), ...options.config });
    const startedAt = Date.now();
    const mintSecret = await ensureMintSecret(config.dataDir);
    const link = await openLinkRelay(config.dataDir, mintSecret, options.linkPush);
    const machines = new MachineAuthority(config.dataDir);
    const owner = (req: IncomingMessage): boolean => {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        return token !== undefined && secureEqual(token, mintSecret);
    };
    const webRoot = process.env.MUXR_WEB_ROOT?.trim();
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
    const serveWeb = async (pathname: string, head: boolean, res: ServerResponse): Promise<boolean> => {
        if (!webRoot || pathname.startsWith('/v1/') || pathname === '/health' || pathname === '/ready') return false;
        let relative: string;
        try { relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, ''); }
        catch { return false; }
        if (relative.startsWith('..')) return false;
        let path = join(webRoot, relative || 'index.html');
        let entryFallback = relative === '' || relative === 'index.html';
        try { if ((await stat(path)).isDirectory()) path = join(path, 'index.html'); }
        catch { path = join(webRoot, 'index.html'); entryFallback = true; }
        try {
            const body = await readFile(path);
            const base = path.split('/').pop() ?? '';
            const entry = path.endsWith('index.html') || base === 'sw.js' || base === 'manifest.webmanifest' || base === 'manifest.json';
            const hashed = /[.-][0-9a-f]{8,}(?:[.-]|$)/i.test(base);
            res.writeHead(200, {
                'content-type': mime[extname(path).toLowerCase()] ?? 'application/octet-stream',
                'cache-control': entry || entryFallback ? 'no-store' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
                'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
                'permissions-policy': 'camera=(self), microphone=(self), geolocation=()',
                'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
            });
            res.end(head ? undefined : body);
            return true;
        } catch { return false; }
    };
    const rate = new Map<string, { until: number; count: number }>();
    const limited = (req: IncomingMessage, max: number): boolean => {
        const ip = clientIp(req, config.trustProxy);
        const now = Date.now();
        const current = rate.get(ip);
        if (current !== undefined && current.until > now) { current.count++; return current.count > max; }
        if (rate.size > 10_000) rate.clear();
        rate.set(ip, { until: now + 60_000, count: 1 });
        return false;
    };
    const http = createServer((req, res) => {
        void (async () => {
            if (!jsonOrigin(req, res, config)) return;
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
            if (await link.request(req, res)) return;
            if (limited(req, 300)) { writeJsonError(res, 429, 'too many requests'); return; }
            if (req.method === 'GET' && url.pathname === '/health') {
                const online = link.hosts().filter((host) => host.online);
                writeJson(res, 200, { ok: true, uptimeMs: Date.now() - startedAt, connectedPeers: link.count(), onlineMachines: online.length,
                    ...(req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1'
                        ? { registeredMachines: link.hosts().length, webEnabled: webRoot !== undefined, bindHost: config.host } : {}) });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/ready') {
                const ready = options.readyCheck === undefined || await options.readyCheck();
                writeJson(res, ready ? 200 : 503, { ok: ready }); return;
            }
            if ((req.method === 'GET' || req.method === 'HEAD') && await serveWeb(url.pathname, req.method === 'HEAD', res)) return;
            if (url.pathname === '/v1/selfhost/enrollments' && req.method === 'POST') {
                if (!owner(req)) { writeJsonError(res, 403, 'relay owner required'); return; }
                const body = await readJsonBody(req).catch(() => undefined) as Record<string, unknown> | undefined;
                const relayUrl = typeof body?.relay_url === 'string' ? body.relay_url.trim() : '';
                let valid = false;
                try { const parsed = new URL(relayUrl); valid = parsed.protocol === 'wss:' && parsed.hostname !== ''
                    && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash; }
                catch { /* invalid address */ }
                if (!valid) { writeJsonError(res, 400, 'relay_url must be a root wss:// URL without credentials'); return; }
                const webUrl = typeof body?.web_url === 'string' ? body.web_url.trim().replace(/\/$/, '') : undefined;
                if (webUrl !== undefined) {
                    try { const parsed = new URL(webUrl); if (parsed.protocol !== 'https:' || parsed.origin !== webUrl) throw new Error('invalid'); }
                    catch { writeJsonError(res, 400, 'web_url must be an origin-only https:// URL'); return; }
                }
                const created = await machines.createEnrollment(relayUrl, webUrl);
                writeJson(res, 201, { enrollment_id: created.id, claim: created.claim, expires_in: created.expiresIn,
                    relay_url: relayUrl, ...(webUrl === undefined ? {} : { web_url: webUrl }) }); return;
            }
            const claim = /^\/v1\/selfhost\/enrollments\/([^/]+)\/claim$/.exec(url.pathname);
            if (req.method === 'POST' && claim?.[1] !== undefined) {
                if (limited(req, 10)) { writeJsonError(res, 429, 'too many requests'); return; }
                const body = await readJsonBody(req).catch(() => undefined) as Record<string, unknown> | undefined;
                const relayUrl = typeof body?.relay_url === 'string' ? body.relay_url : '';
                const signingKey = typeof body?.signing_public_key === 'string' ? body.signing_public_key : '';
                const boxKey = typeof body?.box_public_key === 'string' ? body.box_public_key : '';
                const signature = typeof body?.proof === 'string' ? body.proof : '';
                let proven = false;
                try {
                    const raw = Buffer.from(signingKey, 'base64');
                    const box = Buffer.from(boxKey, 'base64');
                    const sig = Buffer.from(signature, 'base64');
                    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
                    proven = raw.length === 32 && raw.toString('base64') === signingKey && box.length === 32 && box.toString('base64') === boxKey
                        && sig.length === 64 && verify(null, enrollmentProofMessage(claim[1], relayUrl, signingKey, boxKey), key, sig);
                } catch { /* invalid proof */ }
                if (!proven) { writeJsonError(res, 403, 'invalid enrollment proof'); return; }
                const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'agent machine';
                const issued = await machines.claimEnrollment(claim[1], { claim: String(body?.claim ?? ''), relayUrl,
                    signingPublicKey: signingKey, boxPublicKey: boxKey, name });
                if (issued.state !== 'issued') { writeJsonError(res, issued.state === 'already_claimed' ? 409 : issued.state === 'expired' ? 400 : 403, issued.state); return; }
                writeJson(res, 201, { machine_slug: issued.slug, machine_credential: issued.credential,
                    credential_expires_at: new Date(issued.expiresAt).toISOString(), relay_url: issued.relayUrl,
                    ...(issued.webUrl === undefined ? {} : { web_url: issued.webUrl }) }); return;
            }
            const credential = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
            const machine = credential === undefined ? undefined : await machines.resolveCredential(credential);
            if (url.pathname === '/v1/selfhost/machine-status' && machine !== undefined) {
                if (req.method === 'GET') { writeJson(res, 200, { online: link.hosts().some((host) => host.id === machine.linkHostId && host.online) }); return; }
                if (req.method === 'DELETE') {
                    await machines.revokeMachine(machine.slug);
                    await link.revoke(machine.linkHostId);
                    writeJson(res, 200, { ok: true }); return;
                }
            }
            if (url.pathname === '/v1/selfhost/machines' && req.method === 'GET') {
                if (!owner(req)) { writeJsonError(res, 403, 'relay owner required'); return; }
                writeJson(res, 200, { machines: await machines.listMachines() }); return;
            }
            const revoke = /^\/v1\/selfhost\/machines\/([^/]+)$/.exec(url.pathname);
            if (revoke?.[1] !== undefined && req.method === 'DELETE') {
                if (!owner(req)) { writeJsonError(res, 403, 'relay owner required'); return; }
                const result = await machines.revokeMachine(decodeURIComponent(revoke[1]));
                if (result === undefined) { writeJsonError(res, 404, 'machine_not_found'); return; }
                await link.revoke(result.linkHostId);
                writeJson(res, 200, { ok: true }); return;
            }
            writeJson(res, 404, { error: 'not_found' });
        })().catch((error: unknown) => {
            process.stderr.write(`relay HTTP request failed: ${error instanceof Error ? error.message : String(error)}\n`);
            if (!res.headersSent) writeJsonError(res, 500, 'internal error');
        });
    });
    http.requestTimeout = config.publicEdge ? 30_000 : 0;
    http.headersTimeout = 15_000;
    http.on('upgrade', (req, socket, head) => {
        if (!originAllowed(req, config)) { socket.destroy(); return; }
        if (!link.upgrade(req, socket, head)) socket.destroy();
    });
    http.on('connection', (socket) => socket.setNoDelay(true));
    await new Promise<void>((resolve) => http.listen(config.port, config.host, resolve));
    const address = http.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    let mdnsStop: (() => Promise<void>) | undefined;
    if (config.advertiseMdns) {
        try {
            const url = config.mdnsConnectionMode === 'lan' && config.mdnsRelayUrl !== undefined ? new URL(config.mdnsRelayUrl) : undefined;
            if (url !== undefined && !['ws:', 'wss:'].includes(url.protocol)) throw new Error('LAN discovery needs a WebSocket relay URL');
            const defaultPort = url?.protocol === 'wss:' ? 443 : 80;
            const advertised = url === undefined ? port : Number(url.port || defaultPort);
            if (!Number.isInteger(advertised) || advertised < 1 || advertised > 65535) throw new Error('LAN discovery needs a valid advertised port');
            const { advertise } = await import('@byokit/reach');
            const published = await advertise({ type: 'muxr', port: advertised, name: config.mdnsName ?? `muxr-${hostname()}`,
                txt: { v: '2', ...(config.mdnsMachineId === undefined ? {} : { machine: config.mdnsMachineId }),
                    ...(config.mdnsRelayUrl === undefined ? {} : { relay: config.mdnsRelayUrl }),
                    ...(config.mdnsConnectionMode === undefined ? {} : { mode: config.mdnsConnectionMode }) } });
            mdnsStop = published.stop;
        } catch (error) { process.stderr.write(`mDNS advertisement unavailable; discovery disabled (${error instanceof Error ? error.message : String(error)})\n`); }
    }
    return { port, close: async () => {
        await mdnsStop?.();
        link.close();
        await awaitPersistChain();
        await new Promise<void>((resolve) => http.close(() => resolve()));
    } };
}
