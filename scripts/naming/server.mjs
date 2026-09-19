#!/usr/bin/env node
/**
 * muxr self-naming endpoint. Agents name their own workspace and pane.
 *
 * The agent knows what it is working on; no watcher or plugin should guess it
 * from the command line. The endpoint is a thin, authenticated facade over
 * Herdr's current pane/workspace and metadata operations.
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 512;
const MAX_TOKEN_LENGTH = 256;
const MAX_ERROR_LENGTH = 512;
const HERDR_TIMEOUT_MS = 10_000;
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HERDR_TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ALLOWED_FIELDS = new Set(['workspace', 'pane', 'pane_id', 'provider', 'model']);

const port = Number(process.env.MUXR_NAMING_PORT ?? 8797);
const herdrBin = process.env.HERDR_BIN?.trim() || 'herdr';
// Lab isolation: when set, every Herdr call gets a trailing --session <name>.
const herdrSession = process.env.MUXR_NAMING_SESSION?.trim() || undefined;
const muxrHome = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
const authFile = process.env.MUXR_NAMING_AUTH_FILE?.trim() || join(muxrHome, 'naming', 'token');
const configuredToken = process.env.MUXR_NAMING_AUTH_TOKEN?.trim() || undefined;
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

/** A bounded display value. It is never trimmed or otherwise mutated. */
function isName(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_NAME_LENGTH
        && !/[\0-\x1F\x7F]/.test(value);
}

function isPaneId(value) {
    return typeof value === 'string' && PANE_ID.test(value);
}

function boundedError(value) {
    const text = String(value ?? '').replace(/[\0-\x1F\x7F]/g, ' ').trim();
    return text.slice(0, MAX_ERROR_LENGTH) || 'Herdr rejected the operation';
}

function herdrArgs(...command) {
    // The lab helper and the installed Herdr CLI use the trailing global
    // session flag. Keeping it outside the label preserves spaces/punctuation.
    return herdrSession === undefined ? [...command] : [...command, '--session', herdrSession];
}

function parseHerdr(stdout, stderr, error) {
    const text = String(stdout ?? '').trim();
    if (text === '') {
        return error === undefined || error === null
            ? { ok: true, data: undefined }
            : { ok: false, error: boundedError(stderr || error.message) };
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return {
            ok: false,
            error: error === undefined || error === null ? 'Herdr returned an invalid response' : boundedError(stderr || error.message),
        };
    }
    if (payload?.error !== undefined && payload.error !== null) {
        const detail = payload.error;
        return {
            ok: false,
            error: boundedError(typeof detail === 'string' ? detail : `${detail.code ?? 'herdr_error'}: ${detail.message ?? 'Herdr rejected the operation'}`),
        };
    }
    if (error !== undefined && error !== null) return { ok: false, error: boundedError(stderr || error.message) };
    return { ok: true, data: payload?.result };
}

function herdr(...command) {
    return new Promise((resolve) => {
        const env = herdrSession === undefined
            ? process.env
            : { ...process.env, HERDR_SESSION: herdrSession };
        execFile(herdrBin, herdrArgs(...command), {
            timeout: HERDR_TIMEOUT_MS,
            maxBuffer: 1_048_576,
            env,
        }, (error, stdout, stderr) => resolve(parseHerdr(stdout, stderr, error)));
    });
}

async function loadAuthToken() {
    if (configuredToken !== undefined) {
        if (configuredToken.length > MAX_TOKEN_LENGTH) throw new Error('MUXR_NAMING_AUTH_TOKEN is too long');
        return configuredToken;
    }
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
    if (paneId !== undefined && req.headers['x-muxr-pane-id'] !== paneId) return false;
    if (herdrSession !== undefined && req.headers['x-herdr-session'] !== herdrSession) return false;
    return true;
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    return await new Promise((resolve) => {
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                return;
            }
            if (!tooLarge) chunks.push(chunk);
        });
        req.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => resolve(undefined));
    });
}

function responseForOperations(res, results, errors) {
    const keys = Object.keys(results);
    const failed = keys.filter((key) => results[key] !== true);
    const status = failed.length === 0 ? 'ok' : failed.length === keys.length ? 'failed' : 'partial';
    json(res, status === 'ok' ? 200 : 502, {
        ok: status === 'ok',
        status,
        ...(herdrSession === undefined ? {} : { session: herdrSession }),
        results,
        ...(Object.keys(errors).length === 0 ? {} : { errors }),
    });
}

async function handleNaming(req, res) {
    if (!authorized(req)) {
        req.resume();
        return unauthorized(res);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
        return badRequest(res, 'content-type must be application/json');
    }
    const raw = await readBody(req);
    if (raw === undefined) return badRequest(res, 'body too large or unreadable');

    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        return badRequest(res, 'body must be JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return badRequest(res, 'body must be a JSON object');
    }
    if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
        return badRequest(res, 'body contains an unsupported field');
    }

    const { workspace, pane, pane_id: paneId, provider, model } = body;
    for (const [field, value] of Object.entries({ workspace, pane, pane_id: paneId, provider, model })) {
        if (value !== undefined && !isName(value)) {
            return badRequest(res, `${field} must be a non-empty string of at most ${MAX_NAME_LENGTH} characters without control characters`);
        }
    }
    if (paneId !== undefined && !isPaneId(paneId)) return badRequest(res, 'pane_id is not a supported Herdr pane target');
    // ponytail: Herdr's positional rename parser has no safe `--` escape;
    // reject only leading-dash labels rather than letting a name become a flag.
    if (pane?.startsWith('-') || workspace?.startsWith('-')) return badRequest(res, 'pane and workspace names must not start with "-"');
    if (paneId === undefined) return badRequest(res, 'pane_id is required: muxr binds naming to the calling pane');
    if (workspace === undefined && pane === undefined && provider === undefined && model === undefined) {
        return badRequest(res, 'nothing to name: send workspace, pane, provider or model');
    }
    if (!authorized(req, paneId)) return json(res, 403, { ok: false, error: 'request is not authorized for this pane' });

    // Resolve membership from Herdr before the first mutation. The pane id is
    // not allowed to imply a workspace by string convention.
    const current = await herdr('pane', 'get', paneId);
    const currentPane = current.ok ? current.data?.pane : undefined;
    const workspaceId = currentPane?.workspace_id;
    if (!current.ok || typeof workspaceId !== 'string' || !HERDR_TARGET.test(workspaceId)) {
        return json(res, 404, { ok: false, error: 'target pane is not available in the authorized Herdr session' });
    }

    const results = {};
    const errors = {};
    const apply = async (key, ...command) => {
        const result = await herdr(...command);
        results[key] = result.ok;
        if (!result.ok) errors[key] = result.error ?? 'Herdr rejected the operation';
    };

    if (pane !== undefined) await apply('pane', 'pane', 'rename', paneId, pane);
    if (workspace !== undefined) await apply('workspace', 'workspace', 'rename', workspaceId, workspace);
    if (provider !== undefined || model !== undefined) {
        const tokenArgs = [];
        if (provider !== undefined) tokenArgs.push('--token', `provider=${provider}`);
        if (model !== undefined) tokenArgs.push('--token', `model=${model}`);
        await apply('metadata', 'pane', 'report-metadata', paneId, '--source', 'muxr.naming', ...tokenArgs);
    }
    responseForOperations(res, results, errors);
}

const authToken = await loadAuthToken();
const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
        json(res, 200, { ok: true });
        return;
    }
    if (req.method === 'POST' && path === '/api/naming') {
        void handleNaming(req, res).catch((error) => {
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
    process.stdout.write(`naming: listening on 127.0.0.1:${boundPort}${herdrSession === undefined ? '' : ` (session ${herdrSession})`}\n`);
});

server.on('error', (error) => {
    log(`cannot listen: ${error.message}`);
    process.exit(1);
});
