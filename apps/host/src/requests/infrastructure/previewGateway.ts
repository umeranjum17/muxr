/**
 * HTTPS preview gateway: ordinary app delivery, not a request emulator.
 *
 * One plain-HTTP reverse proxy (stock Caddy terminates public TLS in
 * production; in dev it can terminate TLS itself so `*.preview.localhost`
 * opens in a browser) that routes by Host header to a registered project
 * endpoint and admits every request and WebSocket upgrade on a Secure,
 * HttpOnly, host-only `__Host-muxr-preview` cookie mapping to a live lease.
 *
 * Admission is bootstrapped by one one-use POST: `preview.bootstrap` mints a
 * private body inside the E2EE result, the renderer submits it to
 * `/__muxr/bootstrap` exactly once, and the gateway answers the cookie plus a
 * 303 into the app. The renderer never sees a tunnel key or a shared
 * machine credential. Renewal extends admission server-side because
 * admission re-reads lease standing on every request.
 *
 * It is a proxy, so it is written as one on node's own strict HTTP parser:
 * bodies, SSE and bundles are piped with backpressure, never buffered;
 * WebSocket upgrades become a raw duplex after the upstream's own 101,
 * subprotocols and close semantics untouched. Only the gateway's cookie is
 * stripped; application cookies and storage pass. On the way back only a
 * `Set-Cookie` Domain that exactly names the local upstream is dropped
 * (making it host-only) and only a `Location` naming the local upstream
 * authority is mapped to the public origin. No HTML/JS rewriting, no CSP
 * injection or removal, no origin-check disabling: frameworks are told the
 * public host through `X-Forwarded-Proto/Host` and configured with it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { PreviewEndpoint, PreviewEndpointRegistry } from './previewEndpoint.js';
import type { PreviewLeaseRegistry } from './previewLeases.js';

export const PREVIEW_ADMISSION_COOKIE = '__Host-muxr-preview';
export const PREVIEW_BOOTSTRAP_PATH = '/__muxr/bootstrap';

const MAX_HEADER_BYTES = 32 * 1024;
const MAX_HEADER_FIELDS = 100;
const HEADER_DEADLINE_MS = 5_000;
/** Sockets that have not admitted a single request yet. */
const MAX_UNADMITTED_SOCKETS = 32;
/** Connections (plain and upgraded) one endpoint may hold. */
const MAX_CONNECTIONS_PER_ENDPOINT = 64;
/** Admission tokens one lease may hold (a re-bootstrap in an auxiliary frame keeps the old one alive). */
const MAX_ADMISSIONS_PER_LEASE = 4;
const BOOTSTRAP_TTL_MS = 60_000;
const MAX_BOOTSTRAP_BODY_BYTES = 1_024;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Origin-form targets only: no absolute-form authority to disagree with Host. */
const ORIGIN_FORM = /^\/(?!\/)[\x21-\x7e]*$/;
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

interface Admission {
    token: Buffer;
    leaseId: string;
    deviceId: string;
    endpointId: string;
    generation: number;
}

interface Bootstrap extends Admission {
    expiresAt: number;
}

type LeaseStanding = Pick<PreviewLeaseRegistry, 'stands' | 'standsLive' | 'hold'>;

export interface PreviewGatewayOptions {
    endpoints: PreviewEndpointRegistry;
    /**
     * Lease standing. The dispatcher owns the registry and binds it through
     * `bindLeases` once created; until then every request fails closed.
     */
    leases?: LeaseStanding;
    /** Loopback port to listen on; 0 picks an ephemeral one. */
    port?: number;
    /** Dev only: terminate TLS here so `*.preview.localhost` opens in a browser. */
    tls?: { cert: string; key: string };
    now?: () => number;
}

export interface PreviewGateway {
    /** Loopback port Caddy (or a dev browser) reaches. */
    port: number;
    tls: boolean;
    /** Mint the one-use bootstrap body for a lease bound to an endpoint generation. */
    mintBootstrap(lease: { id: string; deviceId: string }, endpoint: PreviewEndpoint, appPath: string): { path: string; body: string; expiresAt: number };
    /** Close every admitted connection of a lease and forget its admissions. */
    closeLease(leaseId: string): void;
    /** The lease registry admission reads. Set once by the dispatcher that owns it. */
    bindLeases(leases: LeaseStanding): void;
    close(): void;
}

function parseCookies(header: string | undefined): { name: string; pair: string }[] {
    if (header === undefined) return [];
    const cookies: { name: string; pair: string }[] = [];
    for (const pair of header.split(';')) {
        const trimmed = pair.trim();
        if (trimmed === '') continue;
        const equals = trimmed.indexOf('=');
        cookies.push({ name: equals === -1 ? trimmed : trimmed.slice(0, equals), pair: trimmed });
    }
    return cookies;
}

function rawCount(raw: string[], name: string): number {
    let count = 0;
    for (let index = 0; index < raw.length; index += 2) {
        if ((raw[index] as string).toLowerCase() === name) count += 1;
    }
    return count;
}

/** Host header without its port, lowercased. */
function hostnameOf(host: string | undefined): string | undefined {
    if (host === undefined) return undefined;
    const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
    return bare === '' ? undefined : bare.toLowerCase();
}

function tokenMatches(offered: string, expected: Buffer): boolean {
    const bytes = Buffer.from(offered, 'utf8');
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

/** Headers to send upstream: hop-by-hop gone, the gateway cookie gone, forwarding facts added. */
function forwardHeaders(request: IncomingMessage, upstreamAuthority: string, publicHost: string, cookie: string | undefined, upgradeTo: string | undefined): Record<string, string | string[]> {
    const drop = new Set(HOP_BY_HOP);
    for (const token of String(request.headers.connection ?? '').split(',')) {
        const trimmed = token.trim().toLowerCase();
        if (trimmed !== '') drop.add(trimmed);
    }
    const out: Record<string, string | string[]> = {};
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = (request.rawHeaders[index] as string).toLowerCase();
        if (drop.has(name) || name === 'host' || name === 'cookie' || name === 'expect' || name === 'content-length'
            || name === 'x-forwarded-proto' || name === 'x-forwarded-host' || name === 'x-forwarded-for') continue;
        const value = request.rawHeaders[index + 1] as string;
        const previous = out[name];
        if (previous === undefined) out[name] = value;
        else if (Array.isArray(previous)) out[name] = [...previous, value];
        else out[name] = [previous, value];
    }
    // The dev server answers to its own authority; the public one travels in
    // the forwarding headers frameworks read. Origin is left exactly as the
    // browser sent it: frameworks decide with their own allowed-origin config.
    out.host = upstreamAuthority;
    out['x-forwarded-proto'] = 'https';
    out['x-forwarded-host'] = publicHost;
    if (cookie !== undefined) out.cookie = cookie;
    if (upgradeTo !== undefined) {
        out.connection = 'Upgrade';
        out.upgrade = upgradeTo;
    }
    return out;
}

/** Response headers back to the browser: hop-by-hop gone, upstream authority mapped narrowly. */
function responseHeaders(headers: IncomingMessage['headers'], upstreamAuthorities: Set<string>, publicOrigin: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        if (name === 'location' && typeof value === 'string') {
            const match = /^(https?):\/\/([^/?#]*)([/?#].*)?$/i.exec(value);
            if (match !== null && upstreamAuthorities.has((match[2] as string).toLowerCase())) {
                out[name] = `${publicOrigin}${match[3] ?? ''}`;
                continue;
            }
            out[name] = value;
            continue;
        }
        if (name === 'set-cookie') {
            const cookies = (Array.isArray(value) ? value : [value]).flatMap((cookie) => {
                const equals = cookie.indexOf('=');
                const cookieName = (equals === -1 ? cookie : cookie.slice(0, equals)).trim();
                // The gateway's own cookie is never the app's to set or clear.
                if (cookieName === PREVIEW_ADMISSION_COOKIE) return [];
                // A Domain naming the local upstream would be rejected by the
                // browser at the preview origin; dropping exactly that
                // attribute makes it host-only. Every other attribute stays.
                return [cookie.replace(/;\s*Domain=(?:localhost|127\.0\.0\.1)\s*(?=;|$)/i, '')];
            });
            if (cookies.length > 0) out[name] = cookies;
            continue;
        }
        out[name] = value;
    }
    return out;
}

function readTls(): { cert: string; key: string } | undefined {
    const cert = process.env.MUXR_PREVIEW_TLS_CERT?.trim();
    const key = process.env.MUXR_PREVIEW_TLS_KEY?.trim();
    if (!cert || !key) return undefined;
    return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
}

/** Production options from the environment. */
export function previewGatewayEnvOptions(): { port: number; tls: { cert: string; key: string } | undefined; publicPort: number } {
    const port = Number(process.env.MUXR_PREVIEW_GATEWAY_PORT ?? 0);
    const tls = readTls();
    const explicitPublic = Number(process.env.MUXR_PREVIEW_PUBLIC_PORT ?? NaN);
    return {
        port: Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 0,
        tls,
        // Behind Caddy the public port is 443; a dev gateway terminating its own
        // TLS is reached on its own port, resolved once it listens.
        publicPort: Number.isInteger(explicitPublic) && explicitPublic > 0 ? explicitPublic : tls === undefined ? 443 : 0,
    };
}

export async function startPreviewGateway(options: PreviewGatewayOptions): Promise<PreviewGateway> {
    const now = options.now ?? Date.now;
    /** Fail closed until the dispatcher binds its registry. */
    let leases: LeaseStanding = options.leases ?? {
        stands: () => false,
        standsLive: async () => false,
        hold: () => {},
    };
    const admissions = new Map<string, Admission>();
    const bootstraps = new Map<string, Bootstrap>();
    /** Every socket the gateway owns (downstream, upstream, upgraded), with what admitted it. */
    const sockets = new Map<Duplex, { endpointId?: string; leaseId?: string; admitted: boolean }>();
    /** Leases whose closer is already registered with the lease registry. */
    const held = new Set<string>();
    let unadmitted = 0;
    let closed = false;

    const track = (socket: Duplex, state: { endpointId?: string; leaseId?: string; admitted: boolean }): void => {
        if (closed) {
            socket.destroy();
            return;
        }
        sockets.set(socket, state);
        socket.once('close', () => {
            const current = sockets.get(socket);
            sockets.delete(socket);
            if (current !== undefined && !current.admitted) unadmitted -= 1;
        });
    };

    const connectionsOf = (endpointId: string): number => {
        let count = 0;
        for (const state of sockets.values()) if (state.endpointId === endpointId) count += 1;
        return count;
    };

    const closeWhere = (matches: (state: { endpointId?: string; leaseId?: string }) => boolean): void => {
        for (const [socket, state] of [...sockets]) if (matches(state)) socket.destroy();
    };

    const closeLease = (leaseId: string): void => {
        for (const [key, admission] of [...admissions]) if (admission.leaseId === leaseId) admissions.delete(key);
        for (const [key, bootstrap] of [...bootstraps]) if (bootstrap.leaseId === leaseId) bootstraps.delete(key);
        held.delete(leaseId);
        closeWhere((state) => state.leaseId === leaseId);
    };

    options.endpoints.onGenerationMoved = (endpoint) => {
        // A new upstream process behind the same port: nothing admitted for
        // the old one carries over, and every live connection is closed.
        for (const [key, admission] of [...admissions]) if (admission.endpointId === endpoint.id) admissions.delete(key);
        for (const [key, bootstrap] of [...bootstraps]) if (bootstrap.endpointId === endpoint.id) bootstraps.delete(key);
        closeWhere((state) => state.endpointId === endpoint.id);
    };

    /** A socket becomes an admitted, attributed connection at its first admitted request. */
    const attribute = (socket: Duplex, endpointId: string, leaseId: string): void => {
        const state = sockets.get(socket);
        if (state === undefined) return;
        if (!state.admitted) {
            state.admitted = true;
            unadmitted -= 1;
        }
        state.endpointId = endpointId;
        state.leaseId = leaseId;
    };

    const refuse = (response: ServerResponse, status: number, text: string): void => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), connection: 'close' });
        response.end(text);
    };
    const refuseRaw = (socket: Duplex, status: number): void => {
        if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} \r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    };

    /** Structural checks plus the admission cookie. Every branch refuses; none repairs. */
    const admit = (request: IncomingMessage): { ok: true; endpoint: PreviewEndpoint; admission: Admission; cookie: string | undefined } | { ok: false; status: number } => {
        if (!ORIGIN_FORM.test(request.url ?? '')) return { ok: false, status: 400 };
        if (rawCount(request.rawHeaders, 'host') !== 1) return { ok: false, status: 400 };
        const hostname = hostnameOf(request.headers.host);
        const endpoint = hostname === undefined ? undefined : options.endpoints.byHostname(hostname);
        if (endpoint === undefined) return { ok: false, status: 403 };
        const cookies = parseCookies(request.headers.cookie);
        const reserved = cookies.filter((cookie) => cookie.name.trim() === PREVIEW_ADMISSION_COOKIE);
        // Duplicates are refused rather than searched: a page that can plant a
        // second copy on another path must not choose which one is checked.
        if (reserved.length !== 1) return { ok: false, status: 403 };
        const offered = (reserved[0] as { pair: string }).pair.slice(PREVIEW_ADMISSION_COOKIE.length + 1);
        // ponytail: linear constant-time scan over at most 16 leases x 4 tokens; index by a keyed hash if that ever grows.
        let admission: Admission | undefined;
        for (const candidate of admissions.values()) if (tokenMatches(offered, candidate.token)) admission = candidate;
        if (admission === undefined) return { ok: false, status: 403 };
        if (admission.endpointId !== endpoint.id || admission.generation !== endpoint.generation) return { ok: false, status: 403 };
        // Lease ending stays with the registry: its holder closes this lease's connections.
        if (!leases.stands(admission.leaseId, admission.deviceId)) return { ok: false, status: 403 };
        const kept = cookies.filter((cookie) => cookie.name.trim() !== PREVIEW_ADMISSION_COOKIE);
        return { ok: true, endpoint, admission, cookie: kept.length === 0 ? undefined : kept.map((cookie) => cookie.pair).join('; ') };
    };

    // SameSite=None because the web app frames this origin cross-site (the
    // PWA origin is the top level), and Partitioned so a browser that
    // partitions third-party cookies still sends it from the frame. Native
    // WebViews load the origin top-level and are unaffected.
    const setCookie = (token: string): string =>
        `${PREVIEW_ADMISSION_COOKIE}=${token}; Secure; HttpOnly; SameSite=None; Partitioned; Path=/`;

    /** One-use bootstrap: verify, mint the admission cookie, redirect into the app. */
    const bootstrap = (request: IncomingMessage, response: ServerResponse): void => {
        const hostname = hostnameOf(request.headers.host);
        const endpoint = hostname === undefined || rawCount(request.rawHeaders, 'host') !== 1 ? undefined : options.endpoints.byHostname(hostname);
        if (endpoint === undefined || request.method !== 'POST') {
            refuse(response, 403, 'Preview not available.\n');
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BOOTSTRAP_BODY_BYTES) {
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('error', () => response.destroy());
        request.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8').trim();
            // A form submission into the iframe/WebView arrives as `bootstrap=<body>`.
            if (String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
                body = new URLSearchParams(body).get('bootstrap') ?? '';
            }
            let found: Bootstrap | undefined;
            for (const candidate of bootstraps.values()) if (tokenMatches(body, candidate.token)) found = candidate;
            // Single use: gone before any check that could still fail.
            if (found !== undefined) bootstraps.delete(found.token.toString('utf8'));
            if (found === undefined || found.expiresAt <= now() || found.endpointId !== endpoint.id || found.generation !== endpoint.generation
                || !leases.stands(found.leaseId, found.deviceId)) {
                refuse(response, 403, 'Preview not available.\n');
                return;
            }
            const bound = found;
            void leases.standsLive(bound.leaseId, bound.deviceId).then((live) => {
                if (response.destroyed) return;
                const current = options.endpoints.get(bound.endpointId);
                if (live !== true || current === undefined || current.generation !== bound.generation) {
                    refuse(response, 403, 'Preview not available.\n');
                    return;
                }
                const mine = [...admissions.values()].filter((admission) => admission.leaseId === bound.leaseId);
                if (mine.length >= MAX_ADMISSIONS_PER_LEASE) {
                    const oldest = mine[0] as Admission;
                    admissions.delete(oldest.token.toString('utf8'));
                }
                const token = randomBytes(32).toString('base64url');
                admissions.set(token, { token: Buffer.from(token, 'utf8'), leaseId: bound.leaseId, deviceId: bound.deviceId, endpointId: bound.endpointId, generation: bound.generation });
                // Lease end (release, expiry, revocation) closes this lease's
                // connections through the registry's own holder path.
                if (!held.has(bound.leaseId)) {
                    held.add(bound.leaseId);
                    leases.hold(bound.leaseId, () => closeLease(bound.leaseId));
                }
                attribute(request.socket, bound.endpointId, bound.leaseId);
                const path = new URLSearchParams(request.url?.split('?')[1] ?? '').get('to') ?? '/';
                response.writeHead(303, {
                    'set-cookie': setCookie(token),
                    location: /^\/(?!\/)/.test(path) ? path : '/',
                    'cache-control': 'no-store',
                    'content-length': '0',
                });
                response.end();
            }, () => refuse(response, 403, 'Preview not available.\n'));
        });
    };

    const proxy = (request: IncomingMessage, response: ServerResponse, expectsContinue: boolean): void => {
        if ((request.url ?? '').split('?')[0] === PREVIEW_BOOTSTRAP_PATH) {
            bootstrap(request, response);
            return;
        }
        const verdict = admit(request);
        if (!verdict.ok) {
            // Nothing dialled, nothing learned: not whether an app is behind
            // this host, nor which.
            refuse(response, verdict.status, verdict.status === 403 ? 'Preview not available.\n' : 'Bad request.\n');
            return;
        }
        const { endpoint, admission } = verdict;
        if (connectionsOf(endpoint.id) >= MAX_CONNECTIONS_PER_ENDPOINT && sockets.get(request.socket)?.endpointId !== endpoint.id) {
            refuse(response, 503, 'Preview busy.\n');
            return;
        }
        attribute(request.socket, endpoint.id, admission.leaseId);
        const upstreamAuthority = `127.0.0.1:${endpoint.port}`;
        const headers = forwardHeaders(request, upstreamAuthority, request.headers.host as string, verdict.cookie, undefined);
        if (expectsContinue) headers.expect = '100-continue';
        let upstream;
        try {
            upstream = httpRequest({
                host: '127.0.0.1',
                port: endpoint.port,
                method: request.method ?? 'GET',
                path: request.url ?? '/',
                headers,
                // No pooling: an ended lease must close exactly its own sockets.
                agent: false,
            });
        } catch {
            refuse(response, 400, 'Bad request.\n');
            return;
        }
        upstream.on('socket', (socket) => track(socket, { endpointId: endpoint.id, leaseId: admission.leaseId, admitted: true }));
        upstream.on('continue', () => {
            response.writeContinue();
            request.pipe(upstream);
        });
        upstream.on('response', (upstreamResponse) => {
            response.writeHead(
                upstreamResponse.statusCode ?? 502,
                responseHeaders(upstreamResponse.headers, new Set([upstreamAuthority, `localhost:${endpoint.port}`]), endpoint.origin),
            );
            // Piped, never buffered: SSE, HMR event streams and bundles all
            // take this path. Truncation ends the response rather than hangs.
            upstreamResponse.on('aborted', () => response.destroy());
            upstreamResponse.on('error', () => response.destroy());
            upstreamResponse.on('close', () => {
                if (!upstreamResponse.complete) response.destroy();
            });
            upstreamResponse.pipe(response);
        });
        upstream.on('error', () => {
            if (response.headersSent) response.destroy();
            else refuse(response, 502, 'App not reachable.\n');
        });
        response.on('close', () => upstream.destroy());
        request.on('error', () => upstream.destroy());
        if (!expectsContinue) request.pipe(upstream);
    };

    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        socket.on('error', () => socket.destroy());
        const verdict = admit(request);
        if (!verdict.ok) {
            refuseRaw(socket, verdict.status);
            return;
        }
        const upgradeTo = String(request.headers.upgrade ?? '').toLowerCase();
        const clientKey = request.headers['sec-websocket-key'];
        // WebSocket only, and not one byte of payload before the handshake
        // finished: bytes in `head` are a message nobody negotiated.
        if (upgradeTo !== 'websocket' || typeof clientKey !== 'string' || head.length > 0) {
            refuseRaw(socket, 400);
            return;
        }
        const { endpoint, admission } = verdict;
        if (connectionsOf(endpoint.id) >= MAX_CONNECTIONS_PER_ENDPOINT) {
            refuseRaw(socket, 503);
            return;
        }
        attribute(socket, endpoint.id, admission.leaseId);
        // Long-lived: standing is read live (approval, session, catalog)
        // before the upstream dial, not just from the cheap sync check.
        void leases.standsLive(admission.leaseId, admission.deviceId).then((live) => {
            if (socket.destroyed) return;
            const current = options.endpoints.get(endpoint.id);
            if (live !== true || current === undefined || current.generation !== admission.generation) {
                refuseRaw(socket, 403);
                return;
            }
            const expectedAccept = createHash('sha1').update(`${clientKey}${WEBSOCKET_GUID}`).digest('base64');
            const upstreamAuthority = `127.0.0.1:${endpoint.port}`;
            let upstream;
            try {
                upstream = httpRequest({
                    host: '127.0.0.1',
                    port: endpoint.port,
                    method: request.method ?? 'GET',
                    path: request.url ?? '/',
                    headers: forwardHeaders(request, upstreamAuthority, request.headers.host as string, verdict.cookie, upgradeTo),
                    agent: false,
                });
            } catch {
                socket.destroy();
                return;
            }
            socket.once('close', () => upstream.destroy());
            upstream.on('socket', (upstreamSocket) => track(upstreamSocket, { endpointId: endpoint.id, leaseId: admission.leaseId, admitted: true }));
            upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead: Buffer) => {
                // A 101 that does not answer this client's key is not a
                // WebSocket server agreeing to this handshake.
                if (socket.destroyed || upstreamResponse.headers['sec-websocket-accept'] !== expectedAccept) {
                    upstreamSocket.destroy();
                    socket.destroy();
                    return;
                }
                const lines = [`HTTP/1.1 101 ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`];
                const headers = responseHeaders(upstreamResponse.headers, new Set([upstreamAuthority, `localhost:${endpoint.port}`]), endpoint.origin);
                for (const [name, value] of Object.entries(headers)) {
                    for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`);
                }
                lines.push('connection: Upgrade', `upgrade: ${upgradeTo}`, '', '');
                socket.write(lines.join('\r\n'));
                if (upstreamHead.length > 0) socket.write(upstreamHead);
                // Raw duplex from here: frames, subprotocol and close
                // handshake belong to the two ends.
                upstreamSocket.pipe(socket);
                socket.pipe(upstreamSocket);
                const drop = (): void => {
                    upstreamSocket.destroy();
                    socket.destroy();
                };
                upstreamSocket.on('error', drop);
                socket.once('close', drop);
                upstreamSocket.once('close', drop);
            });
            // Anything but a 101 is not a WebSocket, so it is not proxied as one.
            upstream.on('response', () => socket.destroy());
            upstream.on('error', () => socket.destroy());
            upstream.end();
        }, () => refuseRaw(socket, 403));
    };

    const serverOptions = {
        maxHeaderSize: MAX_HEADER_BYTES,
        insecureHTTPParser: false,
        joinDuplicateHeaders: false,
        requireHostHeader: true,
        headersTimeout: HEADER_DEADLINE_MS,
        // Off on purpose: uploads and long-lived streams are not cut by a
        // whole-request clock; the header deadline stops slow clients.
        requestTimeout: 0,
        connectionsCheckingInterval: 1_000,
    };
    const server: Server = options.tls === undefined
        ? createHttpServer(serverOptions)
        : createHttpsServer({ ...serverOptions, ...options.tls });
    server.maxHeadersCount = MAX_HEADER_FIELDS;

    server.on(options.tls === undefined ? 'connection' : 'secureConnection', (socket: Duplex) => {
        track(socket, { admitted: false });
        unadmitted += 1;
        if (unadmitted > MAX_UNADMITTED_SOCKETS) socket.destroy();
    });
    server.on('request', (request, response) => proxy(request, response, false));
    server.on('checkContinue', (request, response) => proxy(request, response, true));
    server.on('clientError', (_error, socket) => {
        if (!socket.destroyed) socket.destroy();
    });
    server.on('connect', (_request, socket) => socket.destroy());
    server.on('upgrade', (request, socket, head: Buffer) => upgrade(request, socket, head));

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
        server.close();
        throw new Error('preview: the preview gateway did not take a loopback port');
    }

    return {
        port: address.port,
        tls: options.tls !== undefined,
        mintBootstrap(lease, endpoint, appPath) {
            // One outstanding body per lease; expired ones are swept here.
            for (const [key, stale] of [...bootstraps]) if (stale.expiresAt <= now() || stale.leaseId === lease.id) bootstraps.delete(key);
            const token = randomBytes(32).toString('base64url');
            const expiresAt = now() + BOOTSTRAP_TTL_MS;
            bootstraps.set(token, { token: Buffer.from(token, 'utf8'), leaseId: lease.id, deviceId: lease.deviceId, endpointId: endpoint.id, generation: endpoint.generation, expiresAt });
            // The body is what the renderer posts verbatim as
            // application/x-www-form-urlencoded: a native WebView sends it as
            // is, a web frame unpacks it into hidden fields. The 303 lands on
            // the app path; the gateway only ever redirects within its own origin.
            return { path: `${PREVIEW_BOOTSTRAP_PATH}?to=${encodeURIComponent(appPath)}`, body: `bootstrap=${token}`, expiresAt };
        },
        closeLease,
        bindLeases(registry) {
            leases = registry;
        },
        close() {
            if (closed) return;
            closed = true;
            server.close();
            server.closeAllConnections();
            for (const socket of [...sockets.keys()]) socket.destroy();
            sockets.clear();
            admissions.clear();
            bootstraps.clear();
        },
    };
}
