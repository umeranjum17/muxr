import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * POST /v1/notify: one general notification to every paired device.
 * Any tool on this computer sends `{title, body?, url?, id?}` with a bearer
 * token from the muxr home folder; the host seals the notice per device and
 * fans it out on the same relay push path as lifecycle notices. Unknown JSON
 * fields are ignored so senders can add fields later.
 */

export const NOTIFY_TOKEN_FILENAME = 'notify-token';
const MAX_BODY_BYTES = 8192;
const TOKEN_BYTES = 32;

export interface GeneralNotice {
    title: string;
    body: string;
    url?: string;
    id: string;
}

export function notifyTokenPath(muxrHome: string): string {
    return join(muxrHome, NOTIFY_TOKEN_FILENAME);
}

function validToken(value: string): boolean {
    return /^[A-Za-z0-9_-]{32,}$/.test(value);
}

/** Read the loopback bearer token, creating it owner-only on first use. */
export function readOrCreateNotifyToken(tokenPath: string): string {
    try {
        const existing = readFileSync(tokenPath, 'utf8').trim();
        if (validToken(existing)) {
            try { chmodSync(tokenPath, 0o600); } catch { /* keep serving */ }
            return existing;
        }
    } catch {
        // Missing or unreadable: mint below.
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    try { chmodSync(tokenPath, 0o600); } catch { /* created owner-only already */ }
    return token;
}

/** https always; http only for loopback and tailnet hosts. */
export function allowedNotifyUrl(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host) || host.endsWith('.ts.net');
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function cleanText(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined;
    if (CONTROL_CHARS.test(value)) return undefined;
    return value;
}

/** Validate a parsed /v1/notify body; unknown fields are ignored. */
export function parseGeneralNotice(body: unknown): { notice: GeneralNotice } | { error: string } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be a JSON object' };
    const record = body as Record<string, unknown>;
    const title = cleanText(record.title, 80);
    if (title === undefined) return { error: 'title must be 1-80 plain-text chars' };
    let text = '';
    if (record.body !== undefined) {
        const parsed = typeof record.body === 'string' && record.body.length <= 300 && !CONTROL_CHARS.test(record.body)
            ? record.body
            : undefined;
        if (parsed === undefined) return { error: 'body must be up to 300 plain-text chars' };
        text = parsed;
    }
    let url: string | undefined;
    if (record.url !== undefined) {
        if (typeof record.url !== 'string' || record.url.length > 512 || !allowedNotifyUrl(record.url)) {
            return { error: 'url must be https, or http to localhost or a tailnet host' };
        }
        url = record.url;
    }
    let id: string;
    if (record.id === undefined) {
        id = randomBytes(8).toString('hex');
    } else if (typeof record.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(record.id)) {
        id = record.id;
    } else {
        return { error: 'id must be up to 64 chars [A-Za-z0-9._:-], starting with a letter or digit' };
    }
    return { notice: { title, body: text, ...(url === undefined ? {} : { url }), id } };
}

function bearerToken(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (header === undefined) return undefined;
    const match = /^Bearer (.+)$/.exec(header.trim());
    return match?.[1];
}

function tokensEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isLoopback(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress;
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function readBody(req: IncomingMessage): Promise<{ text: string } | { error: string }> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        });
        req.on('end', () => {
            if (size > MAX_BODY_BYTES) resolve({ error: 'body too large' });
            else resolve({ text: Buffer.concat(chunks).toString('utf8') });
        });
        req.on('error', () => resolve({ error: 'unreadable body' }));
    });
}

export function isNotifyPath(url: string | undefined): boolean {
    if (url === undefined) return false;
    try {
        return new URL(url, 'http://loopback').pathname === '/v1/notify';
    } catch {
        return false;
    }
}

/**
 * Serve one /v1/notify request. Returns true when the path matched (the
 * response is always finished), false when the caller should route elsewhere.
 * Slice 1 answers 202/400/401; same-id replace and the rate limit are
 * follow-ups.
 */
export async function handleNotifyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    deps: { tokenPath: string; send: (notice: GeneralNotice) => number },
): Promise<boolean> {
    if (!isNotifyPath(req.url)) return false;
    if (!isLoopback(req)) {
        res.writeHead(403).end('loopback only');
        return true;
    }
    if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end('method not allowed');
        return true;
    }
    const token = bearerToken(req);
    if (token === undefined) {
        res.writeHead(401).end('bad or missing token');
        return true;
    }
    let expected: string;
    try {
        expected = readOrCreateNotifyToken(deps.tokenPath);
    } catch {
        res.writeHead(500).end('notify token unavailable');
        return true;
    }
    if (!tokensEqual(token, expected)) {
        res.writeHead(401).end('bad or missing token');
        return true;
    }
    const raw = await readBody(req);
    if ('error' in raw) {
        res.writeHead(400).end(raw.error);
        return true;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.text);
    } catch {
        res.writeHead(400).end('body must be JSON');
        return true;
    }
    const result = parseGeneralNotice(parsed);
    if ('error' in result) {
        res.writeHead(400).end(result.error);
        return true;
    }
    const delivered = deps.send(result.notice);
    res.writeHead(202, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: result.notice.id, delivered_to: delivered }));
    return true;
}
