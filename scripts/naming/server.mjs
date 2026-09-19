#!/usr/bin/env node
/**
 * muxr self-naming endpoint. Agents name their own workspace and pane.
 *
 * The agent knows what it is working on; no watcher or plugin should guess it
 * from the command line. Any provider (Pi, Claude, Codex, Z.ai, ...) calls:
 *
 *   curl -s -X POST http://127.0.0.1:8797/api/naming \
 *     -H 'content-type: application/json' \
 *     -d '{"pane_id":"'"$HERDR_PANE_ID"'","workspace":"auth-rework","pane":"Fix login validation","provider":"pi","model":"gemini-3-flash"}'
 *
 * `workspace` renames the caller's Herdr workspace, `pane` renames the pane
 * (the title muxr shows on the phone), and `provider`/`model` are recorded
 * verbatim for quota tooling (herdr pane metadata tokens + the state file).
 * Names pass through exactly as sent: no re-parsing, no stripping.
 *
 * Loopback only. One wired place owns lifecycle: `muxr up` (scripts/setup)
 * spawns this beside the relay and host, so the daemon supervises it.
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 512;
const HERDR_TIMEOUT_MS = 10_000;
// Bounded history: one record per pane, oldest dropped. quota tooling reads
// current truth per pane; it never needs an unbounded audit log.
const STATE_RECORD_LIMIT = 256;

const port = Number(process.env.MUXR_NAMING_PORT ?? 8797);
const herdrBin = process.env.HERDR_BIN?.trim() || 'herdr';
// Lab isolation: when set, EVERY herdr call gets a trailing `--session <name>`
// so the server can never touch another session's workspaces.
const herdrSession = process.env.MUXR_NAMING_SESSION?.trim() || undefined;
const stateFile = process.env.MUXR_NAMING_STATE_FILE?.trim()
    || join(homedir(), '.muxr', 'naming', 'state.json');

function log(message) {
    process.stderr.write(`[naming] ${message}\n`);
}

function badRequest(res, why) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: why }));
}

/** A verbatim name: present, a non-empty string, within bounds. Never mutated. */
function isName(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

function herdrArgs(...command) {
    // The session flag goes BEFORE the subcommand (canonical global-option
    // position) and never after a `--` separator, where it would be eaten as
    // part of a verbatim label.
    return herdrSession === undefined ? [...command] : ['--session', herdrSession, ...command];
}

function herdr(args) {
    return new Promise((resolve) => {
        // Session-scoped spawns carry HERDR_SESSION too: that is how the herdr
        // CLI finds a named session's own server socket (same contract the
        // firstmate lab helper uses).
        const env = herdrSession === undefined
            ? process.env
            : { ...process.env, HERDR_SESSION: herdrSession };
        execFile(herdrBin, args, { timeout: HERDR_TIMEOUT_MS, env }, (error, stdout, stderr) => {
            resolve({ ok: !error, error: error ? String(stderr || error.message).trim() : undefined });
        });
    });
}

async function readState() {
    try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
        return parsed && typeof parsed === 'object' && parsed.panes ? parsed : { panes: {} };
    } catch {
        return { panes: {} };
    }
}

async function writeState(state) {
    const entries = Object.entries(state.panes)
        .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
        .slice(0, STATE_RECORD_LIMIT);
    const bounded = { panes: Object.fromEntries(entries) };
    await mkdir(dirname(stateFile), { recursive: true });
    const staged = join(tmpdir(), `muxr-naming-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    await writeFile(staged, `${JSON.stringify(bounded, null, 2)}\n`);
    await rename(staged, stateFile);
}

async function handleNaming(req, res) {
    const raw = await new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                resolve(undefined);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => resolve(undefined));
    });
    if (raw === undefined) return badRequest(res, 'body too large or unreadable');

    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        return badRequest(res, 'body must be JSON');
    }
    if (typeof body !== 'object' || body === null) return badRequest(res, 'body must be a JSON object');

    const { workspace, pane, pane_id: paneId, provider, model } = body;
    for (const [field, value] of Object.entries({ workspace, pane, pane_id: paneId, provider, model })) {
        if (value !== undefined && !isName(value)) {
            return badRequest(res, `${field} must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
        }
    }
    if (workspace === undefined && pane === undefined && provider === undefined && model === undefined) {
        return badRequest(res, 'nothing to name: send workspace, pane, provider or model');
    }
    if ((pane !== undefined || provider !== undefined || model !== undefined) && paneId === undefined) {
        return badRequest(res, 'pane_id is required (the calling pane knows it as $HERDR_PANE_ID)');
    }
    // A workspace is the part of the pane id before the colon (w1:p2 -> w1).
    const workspaceId = paneId === undefined ? undefined : paneId.split(':', 1)[0];

    const results = {};
    if (pane !== undefined) {
        // The label is ONE argv element (execFile, no shell), so herdr receives
        // it verbatim. ponytail: a label starting with "-" would be misparsed
        // as a flag; herdr's CLI has no `--` escape (it eats it into the label),
        // so reject that one pathological shape instead of corrupting it.
        if (pane.startsWith('-')) return badRequest(res, 'pane name must not start with "-"');
        results.pane = await herdr(herdrArgs('pane', 'rename', paneId, pane));
    }
    if (workspace !== undefined && workspaceId !== undefined) {
        if (workspace.startsWith('-')) return badRequest(res, 'workspace name must not start with "-"');
        results.workspace = await herdr(herdrArgs('workspace', 'rename', workspaceId, workspace));
    }
    // Pane-scoped bookkeeping: metadata tokens (when provider/model given) and
    // the quota-tooling state file (also for plain pane renames).
    if (paneId !== undefined && (pane !== undefined || provider !== undefined || model !== undefined)) {
        if (provider !== undefined || model !== undefined) {
            const tokenArgs = [];
            if (provider !== undefined) tokenArgs.push('--token', `provider=${provider}`);
            if (model !== undefined) tokenArgs.push('--token', `model=${model}`);
            results.metadata = await herdr(herdrArgs('pane', 'report-metadata', paneId, '--source', 'muxr.naming', ...tokenArgs));
        }

        const state = await readState();
        const previous = state.panes[paneId] ?? {};
        // New value wins; an absent field keeps what a previous call recorded.
        const record = { at: Date.now() };
        for (const [field, value] of Object.entries({ workspace, pane, provider, model })) {
            const effective = value !== undefined ? value : previous[field];
            if (effective !== undefined) record[field] = effective;
        }
        state.panes[paneId] = record;
        try {
            await writeState(state);
        } catch (error) {
            log(`state write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const attempted = Object.values(results);
    const failed = attempted.filter((entry) => !entry.ok);
    for (const entry of failed) log(`herdr call failed: ${entry.error}`);
    res.writeHead(attempted.length > 0 && failed.length === attempted.length ? 502 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        ok: failed.length < attempted.length,
        ...(herdrSession === undefined ? {} : { session: herdrSession }),
        results: Object.fromEntries(Object.entries(results).map(([key, entry]) => [key, entry.ok])),
    }));
}

const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (req.method === 'POST' && path === '/api/naming') {
        void handleNaming(req, res).catch((error) => {
            log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'internal error' }));
        });
        return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
    const bound = server.address();
    const actual = typeof bound === 'object' && bound !== null ? bound.port : port;
    // The bound port on stdout is the supervision contract: harnesses start
    // this server with MUXR_NAMING_PORT=0 and read the real port here.
    process.stdout.write(`naming: listening on 127.0.0.1:${actual}${herdrSession === undefined ? '' : ` (session ${herdrSession})`}\n`);
});

server.on('error', (error) => {
    log(`cannot listen: ${error.message}`);
    process.exit(1);
});
