#!/usr/bin/env node
/**
 * muxr's agent loopback. It answers `muxr preview status`: whether the phone
 * holds a pane's browser, emulator, or simulator right now. Naming does not come through
 * here; `muxr name` calls the Herdr CLI itself.
 */

import { createServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_TOKEN_LENGTH = 256;
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const port = Number(process.env.MUXR_NAMING_PORT ?? 8797);
const muxrHome = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
// The host's human-lease file, written beside the naming token directory.
// A reader-side expiry check keeps a dead host from pinning a pane as human.
const previewLeaseFile = join(muxrHome, 'preview', 'lease.json');
const authFile = process.env.MUXR_NAMING_AUTH_FILE?.trim() || join(muxrHome, 'naming', 'token');
let boundPort = port;

function log(message) {
    process.stderr.write(`[naming] ${message}\n`);
}

function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}

function badRequest(res, why) {
    json(res, 400, { ok: false, error: why });
}

function unauthorized(res, why = 'naming authorization required') {
    json(res, 401, { ok: false, error: why }, { 'www-authenticate': 'Bearer' });
}

function isPaneId(value) {
    return typeof value === 'string' && PANE_ID.test(value);
}

async function loadAuthToken() {
    await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
    try {
        const existing = (await readFile(authFile, 'utf8')).trim();
        if (existing.length > 0 && existing.length <= MAX_TOKEN_LENGTH) {
            await chmod(authFile, 0o600);
            return existing;
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const generated = randomBytes(32).toString('base64url');
    await writeFile(authFile, `${generated}\n`, { mode: 0o600 });
    await chmod(authFile, 0o600);
    return generated;
}

function sameSecret(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

function localRequest(req) {
    const address = req.socket.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
    const host = String(req.headers.host ?? '').replace(/^\[|\]$/g, '');
    const [hostname, rawPort] = host.split(':');
    if (!['127.0.0.1', 'localhost'].includes(hostname)) return false;
    return rawPort === undefined || Number(rawPort) === boundPort;
}

function authorized(req, paneId) {
    if (!localRequest(req)) return false;
    if (req.headers.origin !== 'muxr://agent') return false;
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')
        || !sameSecret(authorization.slice('Bearer '.length), authToken)) return false;
    return paneId === undefined || req.headers['x-muxr-pane-id'] === paneId;
}

async function handlePreviewStatus(req, res, url) {
    const paneId = url.searchParams.get('pane_id');
    if (paneId === null || !isPaneId(paneId)) {
        req.resume();
        return badRequest(res, 'pane_id is not a supported Herdr pane target');
    }
    if (!authorized(req)) return unauthorized(res);
    if (req.headers['x-muxr-pane-id'] !== paneId) return json(res, 403, { ok: false, error: 'request is not authorized for this pane' });
    let controller = 'none';
    try {
        const snapshot = JSON.parse(await readFile(previewLeaseFile, 'utf8'));
        const entry = snapshot?.panes?.[paneId];
        if (entry?.controller === 'human' && typeof entry.expiresAt === 'number' && entry.expiresAt > Date.now()) {
            controller = 'human';
        }
    } catch {
        // Absent, corrupt, or unreadable reads as none: status must work
        // with no host running, never fail an agent that only asks.
    }
    json(res, 200, { ok: true, controller });
}

const authToken = await loadAuthToken();
const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
        json(res, 200, { ok: true });
        return;
    }
    if (req.method === 'GET' && path === '/api/preview-status') {
        void handlePreviewStatus(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')).catch((error) => {
            log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
        });
        return;
    }
    json(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
    const bound = server.address();
    boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
    process.stdout.write(`naming: listening on 127.0.0.1:${boundPort}\n`);
});

server.on('error', (error) => {
    log(`cannot listen: ${error.message}`);
    process.exit(1);
});
