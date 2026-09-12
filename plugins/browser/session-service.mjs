#!/usr/bin/env node
/**
 * muxr browser session service: the sole authority over the agent's browser.
 *
 * Launches one pinned Chrome for Testing with a persistent profile under the
 * service state dir, drives it over its private `--remote-debugging-pipe`
 * (no debug port, no endpoint anything else can reach), loads the bundled
 * capture extension, and registers exactly one tab per session. It owns:
 *
 * - the ownership machine (agent-driving / waiting-for-you / taking-control /
 *   you-control / giving-back / paused / checking / ended), with a take
 *   barrier, acknowledged transitions, idempotent commands, a 1 s device
 *   heartbeat (three misses pause authority and release held keys) and a
 *   minimal in-memory transition record (no credentials, DOM or input text);
 * - the agent's semantic operations (navigate, snapshot, click, scroll,
 *   fill, help) -- never raw CDP, evaluation, cookies, interception, init
 *   scripts, recording, extension management or file access -- and their
 *   refusal, status only, whenever a human holds the seat;
 * - the private device channel: sealed under the browser-service grant this
 *   service mints from its own identity, terminated here, relayed opaquely
 *   by the host; SDP/ICE for the extension's peer, input permits, focus
 *   reports and text commits;
 * - the owner-only control socket the host adapter and the local broker
 *   speak newline JSON over.
 *
 * Boundary honesty: on a same-UID host this process, its profile and its
 * socket are readable by anything running as the owner; only a dedicated
 * service user (the packaging lane) makes that a real boundary, and no flag
 * here defeats root. Credential saving and autofill are disabled through
 * the profile's policy-backed preferences, which the same UID could edit.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    deriveBrowserSessionKeys,
    generateKeyPair,
    generateSigningKeyPair,
    mintBrowserServiceGrant,
    newV2ReplayTracker,
    newV2SenderState,
    openBrowserSessionMessage,
    sealBrowserSessionMessage,
} from '@muxr/crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, 'capture-extension');
const PINNED_CHROME = join(homedir(), '.cache/puppeteer/chrome/linux-127.0.6533.72/chrome-linux64/chrome');
const HEARTBEAT_MS = 1_000;
const HEARTBEAT_MISSES = 3;
const PERMIT_EVERY_MS = 100;
const PERMIT_TTL_MS = 300;
const SESSION_IDLE_MS = 60 * 60_000;
/** A take that has not presented a frame within this window is paused, not left half-open. */
const TAKE_HANDSHAKE_MS = 30_000;
const ENDED_KEEP_MS = 10 * 60_000;
const GRANT_TTL_MS = 365 * 24 * 60 * 60_000;
const MAX_SNAPSHOT_LINES = 400;
const MAX_LINE_BYTES = 256 * 1024;
const HUMAN_STATES = new Set(['taking-control', 'you-control', 'giving-back', 'paused']);
const INTERACTIVE_ROLES = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'option', 'listbox']);
const SECRET_FIELD_SELECTOR = 'input[type="password"], input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="passcode" i], input[name*="verification" i]';
const SECRET_HINT = /otp|one.?time|passcode|verification|2fa|mfa|totp|security.?code|pin\b/i;

export function serviceDir() {
    return process.env.MUXR_BROWSER_SERVICE_DIR?.trim() || join(process.env.HOME?.trim() || homedir(), '.muxr', 'browser-service');
}

export function controlSocketPath(dir = serviceDir()) {
    return join(dir, 'control.sock');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

function siteOf(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return /^[a-z0-9.-]+$/.test(host) ? host : '';
    } catch {
        return '';
    }
}

/** Approved navigation targets: http(s) with a host, no credentials. Everything else is refused. */
function approvedUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error('that URL is not allowed');
    let parsed;
    try {
        parsed = new URL(raw.trim());
    } catch {
        throw new Error('that URL is not allowed; use an http or https address');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('only http and https pages can be opened here');
    if (parsed.username !== '' || parsed.password !== '') throw new Error('URLs must not carry credentials');
    if (parsed.hostname === '') throw new Error('that URL has no host');
    return parsed.toString();
}

function extensionId() {
    const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
    const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
    return [...digest.subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join('');
}

// ---------------------------------------------------------------- identity

function loadIdentity(dir) {
    const path = join(dir, 'identity.json');
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    const identity = {
        serviceId: `bsvc_${randomUUID().replaceAll('-', '')}`,
        signing: generateSigningKeyPair(),
        key: generateKeyPair(),
        devices: {},
    };
    writeFileSync(path, JSON.stringify(identity), { mode: 0o600 });
    return identity;
}

function saveIdentity(dir, identity) {
    const path = join(dir, 'identity.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(identity), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
}

// --------------------------------------------------------------------- CDP

class Cdp {
    constructor(proc) {
        this.write = proc.stdio[3];
        this.next = 0;
        this.pending = new Map();
        this.listeners = new Map();
        this.closed = false;
        let buffer = '';
        proc.stdio[4].on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let at;
            while ((at = buffer.indexOf('\0')) !== -1) {
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 1);
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (message.id !== undefined) {
                    const waiter = this.pending.get(message.id);
                    this.pending.delete(message.id);
                    if (waiter === undefined) continue;
                    if (message.error) waiter.reject(new Error(message.error.message ?? 'browser error'));
                    else waiter.resolve(message.result ?? {});
                } else {
                    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
                }
            }
        });
        proc.stdio[4].on('close', () => {
            this.closed = true;
            for (const waiter of this.pending.values()) waiter.reject(new Error('the browser closed'));
            this.pending.clear();
        });
    }

    send(method, params = {}, sessionId) {
        if (this.closed) return Promise.reject(new Error('the browser closed'));
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
        });
    }

    on(method, listener) {
        if (!this.listeners.has(method)) this.listeners.set(method, new Set());
        this.listeners.get(method).add(listener);
        return () => this.listeners.get(method)?.delete(listener);
    }

    waitFor(method, predicate, ms) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${method}`)); }, ms);
            const off = this.on(method, (params, sessionId) => {
                if (!predicate(params, sessionId)) return;
                clearTimeout(timer);
                off();
                resolve(params);
            });
        });
    }
}

// ------------------------------------------------------------- extension

/**
 * Loopback channel between this service and its extension document:
 * SSE down, POST replies up, one random token per launch carried in the
 * viewer URL fragment. Bound to 127.0.0.1 on an ephemeral port that is
 * never printed anywhere.
 */
class ExtensionChannel {
    constructor(onEvent) {
        this.token = randomBytes(24).toString('base64url');
        this.stream = undefined;
        this.pending = new Map();
        this.next = 0;
        this.onEvent = onEvent;
        this.server = createHttpServer((request, response) => this.handle(request, response));
    }

    async listen() {
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
        });
        return this.server.address().port;
    }

    authorized(request, url) {
        const supplied = request.headers.authorization?.startsWith('Bearer ')
            ? request.headers.authorization.slice(7)
            : url.searchParams.get('token') ?? '';
        const left = Buffer.from(supplied);
        const right = Buffer.from(this.token);
        return left.length === right.length && timingSafeEqual(left, right) && /^127\.0\.0\.1(:\d+)?$/.test(request.headers.host ?? '');
    }

    handle(request, response) {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        // The extension document is a cross-origin caller to this loopback
        // server, so its EventSource and fetch need CORS. Access is gated by
        // the per-launch token, not by origin.
        const cors = {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'authorization, content-type',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
        };
        if (request.method === 'OPTIONS') {
            response.writeHead(204, cors);
            response.end();
            return;
        }
        if (!this.authorized(request, url)) {
            response.writeHead(403, cors);
            response.end();
            return;
        }
        if (request.method === 'GET' && url.pathname === '/events') {
            response.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            response.write(':ok\n\n');
            this.stream?.end();
            this.stream = response;
            this.ready?.();
            response.on('close', () => { if (this.stream === response) this.stream = undefined; });
            return;
        }
        if (request.method === 'POST' && url.pathname === '/reply') {
            let body = '';
            request.on('data', (chunk) => { body += chunk; if (body.length > MAX_LINE_BYTES) request.destroy(); });
            request.on('end', () => {
                response.writeHead(204, cors);
                response.end();
                let message;
                try { message = JSON.parse(body); } catch { return; }
                if (message.id !== undefined && this.pending.has(message.id)) {
                    const waiter = this.pending.get(message.id);
                    this.pending.delete(message.id);
                    if (message.ok) waiter.resolve(message.result ?? {});
                    else waiter.reject(new Error(typeof message.error === 'string' ? message.error : 'extension error'));
                    return;
                }
                if (typeof message.event === 'string') this.onEvent(message);
            });
            return;
        }
        response.writeHead(404);
        response.end();
    }

    waitReady(ms) {
        if (this.stream !== undefined) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the capture extension did not connect')), ms);
            this.ready = () => { clearTimeout(timer); this.ready = undefined; resolve(); };
        });
    }

    command(payload, ms = 8_000) {
        if (this.stream === undefined) return Promise.reject(new Error('the capture extension is not connected'));
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('the capture extension did not answer')); }, ms);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            this.stream.write(`data: ${JSON.stringify({ id, ...payload })}\n\n`);
        });
    }

    close() {
        this.stream?.end();
        this.server.close();
    }
}

// ------------------------------------------------------------------ chrome

function seedPreferences(profile) {
    const dir = join(profile, 'Default');
    const path = join(dir, 'Preferences');
    if (existsSync(path)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The preference keys behind the PasswordManagerEnabled / AutofillCreditCardEnabled /
    // AutofillAddressEnabled policies. Machine policy would need root-owned
    // /etc policy files; this is the same-UID equivalent and is honest about it.
    writeFileSync(path, JSON.stringify({
        credentials_enable_service: false,
        credentials_enable_autosignin: false,
        profile: { password_manager_enabled: false, default_content_setting_values: { notifications: 2 } },
        autofill: { credit_card_enabled: false, profile_enabled: false },
        browser: { has_seen_welcome_page: true },
    }), { mode: 0o600 });
}

async function launchChrome(dir, port, token, extension) {
    const binary = process.env.MUXR_BROWSER_BINARY?.trim() || PINNED_CHROME;
    if (!existsSync(binary)) throw new Error('the pinned browser is not installed on this computer');
    const profile = join(dir, 'profile');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    seedPreferences(profile);
    const args = [
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        `--load-extension=${EXTENSION_DIR}`,
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--allowlisted-extension-id=${extension}`,
        '--auto-accept-this-tab-capture',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--no-service-autorun',
        '--password-store=basic',
        '--disable-features=Translate,MediaRouter,OptimizationHints,PasswordManagerOnboarding,AutofillServerCommunication',
        '--autoplay-policy=no-user-gesture-required',
        ...(process.env.MUXR_BROWSER_HEADLESS === '1' ? ['--headless=new'] : []),
        ...(process.env.MUXR_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
        'about:blank',
    ];
    const proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const cdp = new Cdp(proc);
    await cdp.send('Browser.getVersion');
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const viewer = await cdp.send('Target.createTarget', { url: `chrome-extension://${extension}/viewer.html#port=${port}&token=${encodeURIComponent(token)}` });
    return { proc, cdp, viewerTargetId: viewer.targetId };
}

// ----------------------------------------------------------------- service

class BrowserService {
    constructor(dir) {
        this.dir = dir;
        this.identity = loadIdentity(dir);
        this.sessions = new Map();
        this.channel = new ExtensionChannel((event) => this.onExtensionEvent(event));
        this.extension = extensionId();
        this.timer = undefined;
    }

    async start() {
        const port = await this.channel.listen();
        const chrome = await launchChrome(this.dir, port, this.channel.token, this.extension);
        this.chrome = chrome.proc;
        this.cdp = chrome.cdp;
        this.chrome.on('exit', () => this.onBrowserGone());
        await this.channel.waitReady(10_000);
        this.cdp.on('Target.targetDestroyed', ({ targetId }) => this.onTargetDestroyed(targetId));
        this.cdp.on('Target.targetCrashed', ({ targetId }) => this.onTargetDestroyed(targetId));
        this.cdp.on('Target.targetCreated', ({ targetInfo }) => void this.onTargetCreated(targetInfo).catch(() => undefined));
        this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
        this.timer.unref?.();
    }

    async stop() {
        clearInterval(this.timer);
        for (const session of this.sessions.values()) await this.end(session, 'the browser service stopped').catch(() => undefined);
        this.channel.close();
        this.chrome?.kill('SIGTERM');
    }

    // ---- lifecycle

    onBrowserGone() {
        for (const session of this.sessions.values()) {
            if (session.state !== 'ended') this.transition(session, 'ended', { by: 'service', reason: 'the browser was closed' });
        }
        // A destroyed browser is a destroyed service: exit so the supervisor
        // restarts it and every client fails closed until then.
        setTimeout(() => process.exit(1), 100).unref();
    }

    onTargetDestroyed(targetId) {
        for (const session of this.sessions.values()) {
            if (session.targetId === targetId && session.state !== 'ended') {
                this.transition(session, 'ended', { by: 'service', reason: 'the page was closed' });
            } else if (session.child?.targetId === targetId) {
                session.child = undefined;
                if (session.state === 'you-control') void this.recapture(session).catch(() => undefined);
            }
        }
    }

    async onTargetCreated(info) {
        if (info.type !== 'page' || !info.openerId) return;
        const session = [...this.sessions.values()].find((entry) => entry.targetId === info.openerId && entry.state !== 'ended');
        if (session === undefined || session.child !== undefined) return;
        // An OAuth child window is accepted only through its recorded opener,
        // confirmed on both sides: CDP names the opener target, the extension
        // names the opener tab.
        await sleep(200);
        const child = await this.channel.command({ cmd: 'child', openerTabId: session.tabId, url: info.url });
        if (child.tabId === null) return;
        session.child = { targetId: info.targetId, tabId: child.tabId };
        this.record(session, { by: 'service', note: 'child window opened' });
        if (session.state === 'you-control') await this.recapture(session);
    }

    tick() {
        const at = now();
        for (const [handle, session] of this.sessions) {
            if (session.state === 'ended') {
                if (at - session.endedAt > ENDED_KEEP_MS) this.sessions.delete(handle);
                continue;
            }
            // Heartbeats ride the private channel, which exists only once the
            // seat is live; a take still negotiating its peer is bounded by
            // the longer handshake window instead of the 1 s pulse.
            const window = session.state === 'you-control' ? HEARTBEAT_MS * HEARTBEAT_MISSES : TAKE_HANDSHAKE_MS;
            if ((session.state === 'you-control' || session.state === 'taking-control') && session.heartbeatAt !== undefined
                && at - session.heartbeatAt > window) {
                void this.pause(session, 'your device stopped answering');
            }
            if (at > session.expiresAt) {
                if (HUMAN_STATES.has(session.state)) {
                    if (session.state !== 'paused') void this.pause(session, 'the session expired while you held control');
                } else {
                    void this.end(session, 'the session expired');
                }
            }
        }
    }

    // ---- records and status

    record(session, entry) {
        session.transitions.push({ at: now(), state: session.state, generation: session.generation, ...entry });
        if (session.transitions.length > 64) session.transitions.shift();
    }

    transition(session, state, entry = {}) {
        const from = session.state;
        session.state = state;
        // Operator log only (stderr of the service): states and plain
        // reasons, never handles, ids or page content.
        process.stderr.write(`browser service: ${from} -> ${state}${entry.reason ? ` (${entry.reason})` : ''}\n`);
        session.reason = entry.reason;
        if (state === 'ended') session.endedAt = now();
        this.record(session, { from, ...entry });
    }

    touch(session) {
        session.expiresAt = now() + SESSION_IDLE_MS;
    }

    async status(session, deviceId) {
        let navigation = { canGoBack: false, canGoForward: false };
        let site = session.site;
        if (session.state !== 'ended') {
            try {
                const history = await this.cdp.send('Page.getNavigationHistory', {}, session.cdpSession);
                navigation = { canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 };
                site = siteOf(history.entries[history.currentIndex]?.url ?? '');
                session.site = site;
            } catch {
                /* status stays honest with the last known site */
            }
        }
        const owner = session.state === 'agent-driving' ? 'agent'
            : session.state === 'ended' || session.owner === undefined ? 'none'
                : session.owner === deviceId ? 'self' : 'other';
        return {
            generation: session.generation,
            state: session.state,
            owner,
            site,
            navigation,
            ...(session.reason === undefined ? {} : { reason: session.reason }),
            expiresAt: session.expiresAt,
        };
    }

    statusError(session) {
        const error = new Error(session.state === 'ended' ? 'this browser session has ended'
            : session.state === 'agent-driving' ? 'the agent is driving'
                : session.state === 'waiting-for-you' ? 'waiting for the owner'
                    : 'the owner has control');
        error.state = session.state;
        error.generation = session.generation;
        return error;
    }

    // ---- sessions

    async open({ context, name }) {
        const marker = `about:blank#muxr-${randomUUID()}`;
        const target = await this.cdp.send('Target.createTarget', { url: marker });
        const attached = await this.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        await this.cdp.send('Page.enable', {}, attached.sessionId);
        this.cdp.on('Page.frameNavigated', (params, sessionId) => {
            if (sessionId !== attached.sessionId || params.frame?.parentId) return;
            const live = [...this.sessions.values()].find((entry) => entry.cdpSession === sessionId);
            if (live === undefined) return;
            live.documentGeneration += 1;
            if (live.captured) void this.sendGeometry(live);
        });
        let mapped;
        for (let attempt = 0; attempt < 10; attempt += 1) {
            try {
                mapped = await this.channel.command({ cmd: 'map', marker });
                break;
            } catch (error) {
                if (attempt === 9) throw error;
                await sleep(100);
            }
        }
        const session = {
            handle: `bsn_${randomUUID().replaceAll('-', '')}`,
            context: typeof context === 'string' ? context : '',
            // The logical name the agent addresses the session by, kept here
            // so a restarted host can find its sessions again.
            name: typeof name === 'string' && name.length <= 64 ? name : '',
            targetId: target.targetId,
            cdpSession: attached.sessionId,
            tabId: mapped.tabId,
            generation: 1,
            state: 'agent-driving',
            owner: undefined,
            reason: undefined,
            site: '',
            createdAt: now(),
            expiresAt: now() + SESSION_IDLE_MS,
            queue: Promise.resolve(),
            inFlight: undefined,
            lock: Promise.resolve(),
            commands: new Map(),
            refs: new Map(),
            transitions: [],
            heartbeatAt: undefined,
            permits: [],
            seen: new Set(),
            pressed: { keys: new Map(), buttons: new Set(), x: 0, y: 0 },
            pendingCandidates: [],
            viewport: { width: 1280, height: 800, scale: 1 },
            // Generations the device names on every input: the captured
            // target (moves on every capture), the document (moves on every
            // main-frame navigation) and the focused field.
            targetGeneration: 0,
            documentGeneration: 0,
            focusGeneration: 0,
            device: undefined,
            child: undefined,
            captured: false,
            permitTimer: undefined,
        };
        this.sessions.set(session.handle, session);
        this.record(session, { by: 'agent', note: 'opened' });
        return { session: session.handle, site: '' };
    }

    get(handle) {
        const session = this.sessions.get(handle);
        if (session === undefined) {
            const error = new Error('this browser session has ended');
            error.state = 'ended';
            throw error;
        }
        return session;
    }

    async end(session, reason) {
        if (session.state === 'ended') return;
        await this.stopPeer(session);
        this.transition(session, 'ended', { by: 'service', reason });
        await this.cdp.send('Target.closeTarget', { targetId: session.targetId }).catch(() => undefined);
    }

    // ---- agent operations (fenced by the take barrier)

    async agentOp(session, run) {
        if (session.state !== 'agent-driving') throw this.statusError(session);
        const generation = session.generation;
        const task = session.queue.then(async () => {
            // A take that landed while this op was queued rejects it here.
            if (session.generation !== generation || session.state !== 'agent-driving') throw this.statusError(session);
            session.inFlight = run();
            try {
                return await session.inFlight;
            } finally {
                session.inFlight = undefined;
            }
        });
        session.queue = task.catch(() => undefined);
        const result = await task;
        // A take that landed while this op ran discards its result.
        if (session.generation !== generation) throw this.statusError(session);
        this.touch(session);
        return result;
    }

    navigate(session, url) {
        const target = approvedUrl(url);
        return this.agentOp(session, async () => {
            const result = await this.cdp.send('Page.navigate', { url: target }, session.cdpSession);
            if (result.errorText) throw new Error('that page could not be loaded');
            await this.cdp.waitFor('Page.frameStoppedLoading', (params, sessionId) => sessionId === session.cdpSession && params.frameId === result.frameId, 15_000).catch(() => undefined);
            session.refs = new Map();
            session.site = siteOf(target);
            return { site: session.site };
        });
    }

    snapshot(session) {
        return this.agentOp(session, async () => {
            const tree = await this.cdp.send('Accessibility.getFullAXTree', {}, session.cdpSession);
            const refs = new Map();
            const lines = [];
            for (const node of tree.nodes ?? []) {
                if (node.ignored || lines.length >= MAX_SNAPSHOT_LINES) continue;
                const role = node.role?.value ?? '';
                const name = typeof node.name?.value === 'string' ? node.name.value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
                if (role === 'StaticText') {
                    if (name !== '') lines.push(`text ${JSON.stringify(name)}`);
                    continue;
                }
                if (!INTERACTIVE_ROLES.has(role) && role !== 'heading' && role !== 'image') continue;
                if (name === '' && role !== 'textbox' && role !== 'searchbox') continue;
                // Values of editable fields are never part of a snapshot: a
                // password, one-time code or anything the owner typed stays
                // out of the model's view by construction.
                const ref = refs.size + 1;
                if (node.backendDOMNodeId !== undefined && INTERACTIVE_ROLES.has(role)) {
                    refs.set(ref, node.backendDOMNodeId);
                    lines.push(`[${ref}] ${role}${name === '' ? '' : ` ${JSON.stringify(name)}`}`);
                } else {
                    lines.push(`${role} ${JSON.stringify(name)}`);
                }
            }
            session.refs = refs;
            const info = await this.cdp.send('Target.getTargetInfo', { targetId: session.targetId });
            session.site = siteOf(info.targetInfo?.url ?? '');
            return { site: session.site, text: lines.join('\n') };
        });
    }

    async resolveTarget(session, target) {
        if (typeof target === 'number' || /^\d+$/.test(String(target))) {
            const backendNodeId = session.refs.get(Number(target));
            if (backendNodeId === undefined) throw new Error('that element is not in the last snapshot; take a new snapshot');
            return backendNodeId;
        }
        if (typeof target !== 'string' || target === '' || target.length > 512) throw new Error('name an element by snapshot number or CSS selector');
        const doc = await this.cdp.send('DOM.getDocument', { depth: 0 }, session.cdpSession);
        const found = await this.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: target }, session.cdpSession).catch(() => ({ nodeId: 0 }));
        if (!found.nodeId) throw new Error('no element matches that selector');
        const described = await this.cdp.send('DOM.describeNode', { nodeId: found.nodeId }, session.cdpSession);
        return described.node.backendNodeId;
    }

    async describe(session, backendNodeId) {
        const described = await this.cdp.send('DOM.describeNode', { backendNodeId }, session.cdpSession);
        const attributes = {};
        const list = described.node.attributes ?? [];
        for (let index = 0; index + 1 < list.length; index += 2) attributes[list[index].toLowerCase()] = list[index + 1];
        return { nodeName: described.node.nodeName, attributes };
    }

    isSecretField({ nodeName, attributes }) {
        if (nodeName !== 'INPUT') return false;
        const type = (attributes.type ?? 'text').toLowerCase();
        if (type === 'password') return true;
        if ((attributes.autocomplete ?? '').toLowerCase().includes('one-time-code')) return true;
        return SECRET_HINT.test(`${attributes.name ?? ''} ${attributes.id ?? ''} ${attributes['aria-label'] ?? ''} ${attributes.placeholder ?? ''} ${attributes.autocomplete ?? ''}`);
    }

    async centerOf(session, backendNodeId) {
        await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, session.cdpSession).catch(() => undefined);
        const box = await this.cdp.send('DOM.getBoxModel', { backendNodeId }, session.cdpSession);
        const quad = box.model.content;
        return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
    }

    click(session, target) {
        return this.agentOp(session, async () => {
            const backendNodeId = await this.resolveTarget(session, target);
            const { x, y } = await this.centerOf(session, backendNodeId);
            await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, session.cdpSession);
            await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, session.cdpSession);
            await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, session.cdpSession);
            await sleep(150);
            return {};
        });
    }

    fill(session, target, text) {
        if (typeof text !== 'string' || text.length > 4096) throw new Error('fill needs text');
        return this.agentOp(session, async () => {
            const backendNodeId = await this.resolveTarget(session, target);
            const node = await this.describe(session, backendNodeId);
            if (this.isSecretField(node)) throw new Error('that is a password or one-time-code field; ask the owner with `browser session help`');
            await this.cdp.send('DOM.focus', { backendNodeId }, session.cdpSession);
            await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'] }, session.cdpSession);
            await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, session.cdpSession);
            await this.cdp.send('Input.insertText', { text }, session.cdpSession);
            return {};
        });
    }

    scroll(session, dy) {
        const delta = Number(dy);
        if (!Number.isFinite(delta) || Math.abs(delta) > 20_000) throw new Error('scroll needs a distance in pixels');
        return this.agentOp(session, async () => {
            const { width, height } = session.viewport;
            await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: width / 2, y: height / 2, deltaX: 0, deltaY: delta }, session.cdpSession);
            await sleep(100);
            return {};
        });
    }

    async help(session) {
        if (session.state !== 'agent-driving') throw this.statusError(session);
        await session.inFlight?.catch(() => undefined);
        session.owner = undefined;
        this.transition(session, 'waiting-for-you', { by: 'agent' });
        this.touch(session);
        return this.status(session);
    }

    // ---- ownership machine (device side)

    /** Serialize transitions per session and reconcile repeated commands. */
    withLock(session, command, run) {
        const task = session.lock.then(async () => {
            if (command !== undefined && session.commands.has(command)) return session.commands.get(command);
            const result = await run();
            if (command !== undefined) {
                session.commands.set(command, result);
                if (session.commands.size > 64) session.commands.delete(session.commands.keys().next().value);
            }
            return result;
        });
        session.lock = task.catch(() => undefined);
        return task;
    }

    requireDevice(session, deviceId) {
        const entry = this.identity.devices[deviceId];
        if (entry === undefined) throw new Error('this device is not paired with the browser service');
        if (session.device?.deviceId !== deviceId) {
            const keys = deriveBrowserSessionKeys(entry);
            session.device = { deviceId, keys, keyVersion: entry.keyVersion, sender: newV2SenderState(), replay: newV2ReplayTracker() };
        }
        return session.device;
    }

    expect(session, expectedGeneration) {
        if (expectedGeneration !== session.generation) {
            const error = new Error('control changed; refresh the session status');
            error.state = session.state;
            error.generation = session.generation;
            throw error;
        }
    }

    /**
     * The captured surface must be exactly the CSS viewport the device maps
     * taps into: size the tab's window to it (headless honours window
     * bounds per target) and pin the metrics/DPR, so the frame has no
     * chrome, no letterbox inside it and no offset.
     */
    async applyViewport(session) {
        const wanted = session.viewport;
        const scale = Math.min(2, Math.max(1, wanted.scale || 1));
        const target = session.child?.targetId ?? session.targetId;
        const bounds = async (width, height) => {
            const { windowId } = await this.cdp.send('Browser.getWindowForTarget', { targetId: target });
            await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height, windowState: 'normal' } });
            const metrics = await this.cdp.send('Page.getLayoutMetrics', {}, session.cdpSession);
            return { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight };
        };
        try {
            // Window bounds include the window's own frame: measure the
            // client area the page actually got and grow the window by the
            // difference, then record the exact viewport the device maps into.
            let client = await bounds(wanted.width, wanted.height);
            if (client.height !== wanted.height || client.width !== wanted.width) {
                client = await bounds(wanted.width + (wanted.width - client.width), wanted.height + (wanted.height - client.height));
            }
            session.viewport = { width: client.width, height: client.height, scale };
        } catch {
            /* an environment without window bounds keeps the emulated size below */
            await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: wanted.width, height: wanted.height, deviceScaleFactor: scale, mobile: false }, session.cdpSession).catch(() => undefined);
            return;
        }
        // Pin the density only; the size is the real window's.
        await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: scale, mobile: false }, session.cdpSession).catch(() => undefined);
    }

    captureDimensions(session) {
        const scale = Math.min(2, Math.max(1, session.viewport.scale || 1));
        const width = session.viewport.width * scale;
        const height = session.viewport.height * scale;
        const fit = Math.min(1, 1536 / Math.max(width, height));
        return { width: Math.round(width * fit), height: Math.round(height * fit), fps: 60 };
    }

    async captureTarget(session) {
        const target = session.child ?? { targetId: session.targetId, tabId: session.tabId };
        const info = await this.cdp.send('Target.getTargetInfo', { targetId: target.targetId });
        const before = await this.channel.command({ cmd: 'verify', tabId: target.tabId });
        if (before.url !== info.targetInfo.url) throw new Error('the registered tab no longer matches');
        await this.cdp.send('Target.activateTarget', { targetId: target.targetId }).catch(() => undefined);
        const captured = await this.channel.command({ cmd: 'capture', tabId: target.tabId, url: info.targetInfo.url, ...this.captureDimensions(session) });
        const after = await this.channel.command({ cmd: 'verify', tabId: target.tabId });
        if (after.url !== info.targetInfo.url) throw new Error('the registered tab changed during capture');
        session.captured = true;
        session.targetGeneration += 1;
        return captured;
    }

    /** What the device may map taps into: the CSS viewport and the generations it must quote. */
    async sendGeometry(session) {
        if (!session.captured) return;
        const { width, height } = session.viewport;
        await this.channel.command({ cmd: 'send', channel: 'control', generation: session.generation, data: {
            type: 'geometry', generation: session.generation, target: session.targetGeneration, document: session.documentGeneration, width, height,
        } }, 1_000).catch(() => undefined);
    }

    recapture(session) {
        return this.captureTarget(session);
    }

    async stopPeer(session) {
        clearInterval(session.permitTimer);
        session.permitTimer = undefined;
        session.permits = [];
        session.pendingCandidates = [];
        session.heartbeatAt = undefined;
        await this.releasePressed(session);
        if (session.captured) {
            session.captured = false;
            await this.channel.command({ cmd: 'stop' }).catch(() => undefined);
        }
    }

    async releasePressed(session) {
        const { keys, buttons, x, y } = session.pressed;
        for (const [code, key] of keys) {
            await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code, windowsVirtualKeyCode: key.vk }, session.cdpSession).catch(() => undefined);
        }
        for (const button of buttons) {
            await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }, session.cdpSession).catch(() => undefined);
        }
        keys.clear();
        buttons.clear();
    }

    /**
     * Take control (and resume, which is a take by the current holder):
     * the barrier increments the generation first, so every queued agent
     * op is rejected and every in-flight result discarded; then dispatched
     * input is settled, held keys released, the old peer dropped and the
     * registered tab captured afresh. Success leaves `taking-control`
     * until the device acknowledges a presented frame; failure keeps the
     * seat locked as `paused` with a plain reason.
     */
    take(session, deviceId, expectedGeneration, command) {
        return this.withLock(session, command, async () => {
            if (session.state === 'ended') throw this.statusError(session);
            this.expect(session, expectedGeneration);
            this.requireDevice(session, deviceId);
            const from = session.state;
            session.generation += 1;
            session.owner = deviceId;
            session.commands.clear();
            this.transition(session, 'taking-control', { by: 'device', from, command });
            await session.inFlight?.catch(() => undefined);
            session.refs = new Map();
            await this.stopPeer(session);
            // Capture waits for the device's hello: the tab is sized to that
            // device's viewport first, and a tab capture keeps the surface
            // size it started with, so capturing before the resize would
            // stream the old geometry inset in a stale frame.
            this.touch(session);
            return this.status(session, deviceId);
        });
    }

    pause(session, reason, deviceId, expectedGeneration, command) {
        return this.withLock(session, command, async () => {
            if (session.state === 'ended') throw this.statusError(session);
            if (deviceId !== undefined) {
                this.expect(session, expectedGeneration);
                if (session.owner !== deviceId) throw this.statusError(session);
            }
            if (session.state === 'you-control' || session.state === 'taking-control' || session.state === 'giving-back') {
                await this.stopPeer(session);
                this.transition(session, 'paused', { by: deviceId === undefined ? 'service' : 'device', reason, command });
            }
            return this.status(session, deviceId ?? session.owner);
        });
    }

    resume(session, deviceId, expectedGeneration, command) {
        if (session.owner !== deviceId || session.state !== 'paused') {
            return this.withLock(session, command, async () => { throw this.statusError(session); });
        }
        return this.take(session, deviceId, expectedGeneration, command);
    }

    /**
     * Give back: settle, scrub every held login frame's secret fields
     * without reloading, require a page with no sign-in field left, then
     * reopen agent observation under a fresh generation so old permits and
     * peers are dead. Uncertain completion stays private and says why.
     */
    giveBack(session, deviceId, expectedGeneration, command) {
        return this.withLock(session, command, async () => {
            if (session.state === 'ended') throw this.statusError(session);
            this.expect(session, expectedGeneration);
            if (session.owner !== deviceId || !HUMAN_STATES.has(session.state)) throw this.statusError(session);
            this.transition(session, 'giving-back', { by: 'device', command });
            await this.stopPeer(session);
            const remaining = await this.scrubSecrets(session);
            if (remaining > 0) {
                this.transition(session, 'paused', { by: 'service', reason: 'a sign-in field is still on this page; finish signing in before giving back' });
                return this.status(session, deviceId);
            }
            session.generation += 1;
            session.owner = undefined;
            session.commands.clear();
            session.device = undefined;
            this.transition(session, 'agent-driving', { by: 'device', command });
            this.touch(session);
            return this.status(session, deviceId);
        });
    }

    /** Clear secret field values in every same-process frame; returns how many visible secret fields remain. */
    async scrubSecrets(session) {
        const tree = await this.cdp.send('Page.getFrameTree', {}, session.cdpSession);
        const frames = [];
        const walk = (node) => { frames.push(node.frame.id); for (const child of node.childFrames ?? []) walk(child); };
        walk(tree.frameTree);
        let remaining = 0;
        for (const frameId of frames) {
            try {
                // ponytail: out-of-process iframes are separate targets and are
                // not scrubbed here; auto-attach them when a login flow needs it.
                const world = await this.cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'muxr-scrub', grantUniveralAccess: false }, session.cdpSession);
                const result = await this.cdp.send('Runtime.evaluate', {
                    contextId: world.executionContextId,
                    returnByValue: true,
                    expression: `(() => { let left = 0; for (const field of document.querySelectorAll(${JSON.stringify(SECRET_FIELD_SELECTOR)})) { field.value = ''; if (field.offsetParent !== null) left += 1; } return left; })()`,
                }, session.cdpSession);
                remaining += Number(result.result?.value ?? 0);
            } catch {
                /* a frame that vanished mid-scrub holds nothing */
            }
        }
        return remaining;
    }

    // ---- private device channel

    scopeFor(session, device) {
        return { serviceId: this.identity.serviceId, deviceId: device.deviceId, session: session.handle, generation: session.generation, keyVersion: device.keyVersion };
    }

    /**
     * The owner watches while the agent drives (and while waiting for them):
     * view-only media under the current generation, no permits, no input.
     * Taking control moves the generation and recreates the peer, so a watch
     * never keeps the keys of a private seat.
     */
    watching(session) {
        return session.state === 'agent-driving' || session.state === 'waiting-for-you';
    }

    async signal(session, deviceId, generation, message) {
        if (session.state === 'ended') throw this.statusError(session);
        if (!this.watching(session) && session.owner !== deviceId) throw this.statusError(session);
        if (generation !== session.generation) throw this.statusError(session);
        const device = this.requireDevice(session, deviceId);
        const scope = this.scopeFor(session, device);
        let opened;
        try {
            opened = openBrowserSessionMessage(message, device.keys, scope, 'device->service', device.replay);
        } catch {
            throw new Error('that message is not for this session');
        }
        const reply = await this.handleSignal(session, device, opened);
        this.touch(session);
        return { message: sealBrowserSessionMessage(reply, device.keys, scope, 'service->device', device.sender) };
    }

    async handleSignal(session, device, message) {
        const type = typeof message?.type === 'string' ? message.type : '';
        const candidates = () => { const list = session.pendingCandidates; session.pendingCandidates = []; return list; };
        switch (type) {
            case 'hello': {
                const viewport = message.viewport ?? {};
                const width = Math.min(4096, Math.max(320, Math.round(Number(viewport.width) || 1280)));
                const height = Math.min(4096, Math.max(320, Math.round(Number(viewport.height) || 800)));
                const scale = Math.min(2, Math.max(1, Number(viewport.scale) || 1));
                // Watching never changes the host viewport; only the seat holder's does.
                if (!this.watching(session)) session.viewport = { width, height, scale };
                if (session.state === 'taking-control' || session.state === 'you-control') {
                    await this.applyViewport(session);
                    if (!session.captured) {
                        try {
                            const captured = await this.captureTarget(session);
                            this.record(session, { by: 'service', note: `captured (${captured.invocation})` });
                        } catch (error) {
                            this.transition(session, 'paused', { by: 'service', reason: 'could not take control' });
                            this.record(session, { by: 'service', note: error instanceof Error ? error.message : 'capture failed' });
                            return { type: 'status', status: await this.status(session, device.deviceId), viewport: session.viewport };
                        }
                    }
                    void this.sendGeometry(session);
                }
                session.heartbeatAt = now();
                return { type: 'status', status: await this.status(session, device.deviceId), viewport: session.viewport };
            }
            case 'offer': {
                if (session.state !== 'taking-control' && !this.watching(session)) throw this.statusError(session);
                if (!session.captured) await this.captureTarget(session);
                if (typeof message.sdp !== 'string' || message.sdp.length > 64 * 1024) throw new Error('that offer is invalid');
                session.heartbeatAt = now();
                const answer = await this.channel.command({ cmd: 'answer', generation: session.generation, sdp: message.sdp });
                this.record(session, { by: 'service', note: `peer offered (${answer.codec})` });
                return { type: 'answer', sdp: answer.sdp, fingerprint: answer.fingerprint, codec: answer.codec, generation: session.generation };
            }
            case 'ice':
                if (message.candidate) await this.channel.command({ cmd: 'ice', generation: session.generation, candidate: message.candidate }).catch(() => undefined);
                return { type: 'ice', candidates: candidates() };
            case 'heartbeat':
                session.heartbeatAt = now();
                return { type: 'ice', candidates: candidates(), status: await this.status(session, device.deviceId) };
            case 'presented': {
                if (session.state === 'taking-control' && session.captured) {
                    this.transition(session, 'you-control', { by: 'device' });
                    session.heartbeatAt = now();
                    this.startPermits(session);
                }
                return { type: 'status', status: await this.status(session, device.deviceId) };
            }
            case 'focus':
                return { type: 'focus', ...(await this.focusInfo(session)) };
            default:
                throw new Error('unknown private message');
        }
    }

    startPermits(session) {
        clearInterval(session.permitTimer);
        const generation = session.generation;
        session.permitTimer = setInterval(() => {
            if (session.state !== 'you-control' || session.generation !== generation) { clearInterval(session.permitTimer); return; }
            const permit = { id: randomBytes(8).toString('hex'), issuedAt: now() };
            session.permits = [...session.permits.filter((entry) => now() - entry.issuedAt <= PERMIT_TTL_MS), permit];
            void this.channel.command({ cmd: 'send', channel: 'control', generation, data: { type: 'permit', generation, permit: permit.id, expiresAt: permit.issuedAt + PERMIT_TTL_MS } }, 1_000).catch(() => undefined);
        }, PERMIT_EVERY_MS);
        session.permitTimer.unref?.();
    }

    onExtensionEvent(event) {
        const session = [...this.sessions.values()].find((entry) => entry.captured && entry.generation === event.generation);
        if (session === undefined) return;
        if (event.event === 'input') {
            void this.onInput(session, event.intent).catch(() => undefined);
        } else if (event.event === 'channel' && event.channel === 'control') {
            void this.sendGeometry(session).then(() => this.reportFocus(session)).catch(() => undefined);
        } else if (event.event === 'capture-ended' || (event.event === 'peer' && (event.connection === 'failed' || event.connection === 'closed'))) {
            if (session.state === 'you-control' || session.state === 'taking-control') void this.pause(session, event.event === 'capture-ended' ? 'the page capture stopped' : 'the private connection dropped');
        } else if (event.event === 'ice' && event.candidate) {
            session.pendingCandidates.push(event.candidate);
            if (session.pendingCandidates.length > 64) session.pendingCandidates.shift();
        }
    }

    /** Device input: only in you-control, only with a live permit, only once per identity. */
    /**
     * Device messages on the private lanes, in the device's own vocabulary:
     * heartbeat and release carry no permit; every other message is a
     * discrete input that must quote the current generation, a live permit,
     * a unique id and the target/document generations it was made for.
     */
    async onInput(session, intent) {
        if (typeof intent !== 'object' || intent === null || intent.generation !== session.generation) return;
        if (intent.type === 'heartbeat') { session.heartbeatAt = now(); return; }
        if (intent.type === 'release') { await this.releasePressed(session); return; }
        if (session.state !== 'you-control') return;
        const permit = session.permits.find((entry) => entry.id === intent.permit);
        if (permit === undefined || now() - permit.issuedAt > PERMIT_TTL_MS) return;
        if (intent.target !== session.targetGeneration || intent.document !== session.documentGeneration) return;
        const motion = intent.type === 'touch' && intent.phase === 'move';
        if (!motion) {
            if (typeof intent.id !== 'string' || intent.id === '' || session.seen.has(intent.id)) return;
            session.seen.add(intent.id);
            if (session.seen.size > 512) session.seen.delete(session.seen.values().next().value);
        }
        const { width, height } = session.viewport;
        const point = (value, max) => Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
        const x = point(Number(intent.x), width);
        const y = point(Number(intent.y), height);
        const target = session.cdpSession;
        const pressed = session.pressed;
        const mouse = (type, px, py, button = 'left') => this.cdp.send('Input.dispatchMouseEvent', { type, x: px, y: py, button, clickCount: 1 }, target);
        const keyPair = async (key, code, vk, text) => {
            pressed.keys.set(code, { key, vk });
            await this.cdp.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(text === undefined ? {} : { text }) }, target);
            pressed.keys.delete(code);
            await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }, target);
        };
        switch (intent.type) {
            case 'tap':
                if (x === undefined || y === undefined) return;
                pressed.x = x; pressed.y = y;
                await mouse('mouseMoved', x, y, 'none');
                pressed.buttons.add('left');
                await mouse('mousePressed', x, y);
                pressed.buttons.delete('left');
                await mouse('mouseReleased', x, y);
                await this.reportFocus(session);
                return;
            case 'touch':
                if (intent.phase === 'end') {
                    if (!pressed.buttons.has('left')) return;
                    pressed.buttons.delete('left');
                    await mouse('mouseReleased', pressed.x, pressed.y);
                    await this.reportFocus(session);
                    return;
                }
                if (x === undefined || y === undefined) return;
                pressed.x = x; pressed.y = y;
                if (intent.phase === 'start') {
                    pressed.buttons.add('left');
                    await mouse('mousePressed', x, y);
                } else {
                    await mouse('mouseMoved', x, y, pressed.buttons.has('left') ? 'left' : 'none');
                }
                return;
            case 'wheel':
                if (x === undefined || y === undefined) return;
                await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Number(intent.deltaX) || 0, deltaY: Number(intent.deltaY) || 0 }, target);
                return;
            case 'key': {
                const keys = { Enter: ['Enter', 13, '\r'], Backspace: ['Backspace', 8, undefined], Tab: ['Tab', 9, '\t'] };
                const spec = keys[intent.key];
                if (spec === undefined) return;
                await keyPair(intent.key, spec[0], spec[1], spec[2]);
                await this.reportFocus(session);
                return;
            }
            case 'commit':
            case 'insertText': {
                // One committed edit applied once to the focused field: the
                // device keeps composition local and sends the result.
                if (typeof intent.text !== 'string' || intent.text.length > 4096) return;
                if (intent.type === 'commit') {
                    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'] }, target);
                    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, target);
                }
                await this.cdp.send('Input.insertText', { text: intent.text }, target);
                await this.reportFocus(session);
                return;
            }
            case 'navigate': {
                const history = await this.cdp.send('Page.getNavigationHistory', {}, target);
                const index = history.currentIndex + (intent.direction === 'back' ? -1 : 1);
                const entry = history.entries[index];
                if (entry !== undefined) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, target);
                return;
            }
            default:
                return;
        }
    }

    /** What the device may know about the focused field: type, label, secret or not; a value only when it is not secret. */
    async focusInfo(session) {
        try {
            const tree = await this.cdp.send('Page.getFrameTree', {}, session.cdpSession);
            const world = await this.cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'muxr-focus' }, session.cdpSession);
            const result = await this.cdp.send('Runtime.evaluate', {
                contextId: world.executionContextId,
                returnByValue: true,
                expression: `(() => {
                    const el = document.activeElement;
                    if (!el || !(el.matches('input, textarea, [contenteditable=""], [contenteditable="true"]'))) return { editable: false };
                    const type = (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : 'text')).toLowerCase();
                    const hints = [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, el.autocomplete].filter(Boolean).join(' ');
                    const label = (el.labels && el.labels[0] && el.labels[0].textContent || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 80);
                    const secret = type === 'password' || /one-time-code/i.test(el.autocomplete || '') || ${SECRET_HINT.toString()}.test(hints);
                    const inputMode = el.inputMode || (type === 'number' || type === 'tel' ? 'numeric' : 'text');
                    return { editable: true, type: secret ? (type === 'password' ? 'password' : 'otp') : type, label, secret, inputMode, ...(secret ? {} : { value: String(el.value ?? el.textContent ?? '').slice(0, 4096) }) };
                })()`,
            }, session.cdpSession);
            return { generation: session.generation, ...(result.result?.value ?? { editable: false }) };
        } catch {
            return { generation: session.generation, editable: false };
        }
    }

    async reportFocus(session) {
        const info = await this.focusInfo(session);
        session.focusGeneration += 1;
        const kinds = { text: 'text', textarea: 'text', password: 'password', otp: 'otp', email: 'email', tel: 'tel', number: 'number', url: 'url', search: 'search' };
        const field = info.editable
            ? { kind: kinds[info.type] ?? 'text', label: info.label ?? '', ...(info.value === undefined ? {} : { value: info.value }) }
            : null;
        await this.channel.command({ cmd: 'send', channel: 'control', generation: session.generation, data: {
            type: 'focus', generation: session.generation, target: session.targetGeneration, document: session.documentGeneration, focus: session.focusGeneration, field,
        } }, 1_000).catch(() => undefined);
    }

    // ---- enrollment (owner-only socket; never reachable through agent commands)

    enroll({ deviceId, devicePublicKey }) {
        if (typeof deviceId !== 'string' || deviceId === '' || typeof devicePublicKey !== 'string') throw new Error('enrollment needs a device id and key');
        const previous = this.identity.devices[deviceId];
        const entry = {
            devicePublicKey,
            dataKey: randomBytes(32).toString('base64'),
            ingressKey: randomBytes(32).toString('base64'),
            keyVersion: (previous?.keyVersion ?? 0) + 1,
            expiresAt: now() + GRANT_TTL_MS,
        };
        const grant = mintBrowserServiceGrant({
            serviceId: this.identity.serviceId,
            serviceSigningSecretKey: this.identity.signing.secretKey,
            serviceKey: this.identity.key,
            deviceId,
            devicePublicKey,
            dataKey: entry.dataKey,
            ingressKey: entry.ingressKey,
            keyVersion: entry.keyVersion,
            expiresAt: entry.expiresAt,
        });
        this.identity.devices[deviceId] = entry;
        saveIdentity(this.dir, this.identity);
        for (const session of this.sessions.values()) if (session.device?.deviceId === deviceId) session.device = undefined;
        return { grant, serviceId: this.identity.serviceId, signingPublicKey: this.identity.signing.publicKey, expiresAt: entry.expiresAt };
    }

    revoke({ deviceId }) {
        delete this.identity.devices[deviceId];
        saveIdentity(this.dir, this.identity);
        for (const session of this.sessions.values()) {
            if (session.owner === deviceId && HUMAN_STATES.has(session.state) && session.state !== 'paused') void this.pause(session, 'this device was unpaired');
            if (session.device?.deviceId === deviceId) session.device = undefined;
        }
        return {};
    }

    // ---- control socket dispatch

    async handle(op, params = {}) {
        switch (op) {
            case 'service.status':
                return { ready: true, sessions: [...this.sessions.values()].filter((session) => session.state !== 'ended').length, extension: this.channel.stream !== undefined };
            case 'device.enroll':
                return this.enroll(params);
            case 'device.revoke':
                return this.revoke(params);
            case 'session.open':
                return this.open(params);
            case 'session.find': {
                const found = [...this.sessions.values()].find((entry) => entry.state !== 'ended' && entry.name === params.name && entry.context === params.context);
                return found === undefined ? {} : { session: found.handle, site: found.site };
            }
            case 'session.close': {
                const session = this.sessions.get(params.session);
                if (session !== undefined) await this.end(session, 'closed by the agent');
                return {};
            }
        }
        const session = this.get(params.session);
        switch (op) {
            case 'session.status':
                return this.status(session, params.deviceId);
            case 'session.navigate':
                return this.navigate(session, params.url);
            case 'session.snapshot':
                return this.snapshot(session);
            case 'session.click':
                return this.click(session, params.target);
            case 'session.fill':
                return this.fill(session, params.target, params.text);
            case 'session.scroll':
                return this.scroll(session, params.dy);
            case 'session.help':
                return this.help(session);
            case 'session.take':
                return this.take(session, requireText(params.deviceId), params.expectedGeneration, requireText(params.command));
            case 'session.pause':
                return this.pause(session, 'paused by you', requireText(params.deviceId), params.expectedGeneration, requireText(params.command));
            case 'session.resume':
                return this.resume(session, requireText(params.deviceId), params.expectedGeneration, requireText(params.command));
            case 'session.return':
                return this.giveBack(session, requireText(params.deviceId), params.expectedGeneration, requireText(params.command));
            case 'session.signal':
                return this.signal(session, requireText(params.deviceId), params.generation, requireText(params.message));
            default:
                throw new Error('unknown browser service operation');
        }
    }
}

function requireText(value) {
    if (typeof value !== 'string' || value === '') throw new Error('invalid browser service request');
    return value;
}

// ---------------------------------------------------------- control socket

function serveControl(service, path) {
    if (existsSync(path)) {
        if (!lstatSync(path).isSocket()) throw new Error('browser service socket path is not a socket');
        unlinkSync(path);
    }
    const server = createNetServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            if (buffer.length > MAX_LINE_BYTES) { socket.destroy(); return; }
            let at;
            while ((at = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 1);
                void (async () => {
                    let id = '';
                    try {
                        const message = JSON.parse(line);
                        id = typeof message.id === 'string' ? message.id : '';
                        const data = await service.handle(message.op, message.params ?? {});
                        if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ok: true, data })}\n`);
                    } catch (error) {
                        if (!socket.destroyed) {
                            socket.write(`${JSON.stringify({
                                id,
                                ok: false,
                                error: error instanceof Error ? error.message : 'browser service request failed',
                                ...(error?.state === undefined ? {} : { state: error.state, generation: error.generation }),
                            })}\n`);
                        }
                    }
                })();
            }
        });
        socket.on('error', () => undefined);
    });
    server.listen(path, () => chmodSync(path, 0o600));
    return server;
}

export async function startBrowserService(dir = serviceDir()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const service = new BrowserService(dir);
    await service.start();
    const server = serveControl(service, controlSocketPath(dir));
    const stop = async () => {
        server.close();
        await service.stop();
        try { unlinkSync(controlSocketPath(dir)); } catch { /* gone */ }
    };
    return { service, stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const { stop } = await startBrowserService();
    process.stdout.write('browser service: ready\n');
    const shutdown = () => { void stop().finally(() => process.exit(0)); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}
