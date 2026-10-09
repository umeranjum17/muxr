import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, createServer, type Server, type Socket } from 'node:net';

import { EngineClient, EngineRefused, resolveEngine } from '@desklink/host';
import type { DesktopEvent, DesktopPermission, DesktopSurfaceGeometry, PreviewPresence } from '@trymuxr/contract';

import { onPath } from '../infrastructure/x11Display.js';
import type { PreviewLeaseTracker } from './previewLease.js';
import type { ScrcpyVideoEvent } from './scrcpy.js';
import {
    ANDROID_ACTION_DOWN,
    ANDROID_ACTION_UP,
    ANDROID_KEYCODE_APP_SWITCH,
    ANDROID_KEYCODE_HOME,
    ANDROID_TOUCH_CANCEL,
    ANDROID_TOUCH_DOWN,
    ANDROID_TOUCH_MOVE,
    ANDROID_TOUCH_UP,
    RESET_VIDEO_MESSAGE,
    ROTATE_DEVICE_MESSAGE,
    ScrcpyVideoParser,
    encodeBackOrScreenOn,
    encodeInjectKeycode,
    encodeScroll,
    encodeText,
    encodeTouch,
    toAccessUnit,
} from './scrcpy.js';

/**
 * Android emulators via scrcpy, with or without a desktop window.
 *
 * This watches `/proc` for an emulator attributed to an agent pane,
 * starts the vendored scrcpy-server on it, and carries its H.264 through the
 * engine's encoded source — the same WebRTC path as every other preview, with
 * the phone's touch and device keys translated back into scrcpy control
 * messages. A windowed emulator uses the same device mirror, not a private
 * Browser screen.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** An emulator, and the pane whose ancestry owns it. */
export interface DiscoveredEmulator {
    pid: number;
    paneId: string;
    /** Console port from `-port`, or the console listen socket. */
    port?: number | undefined;
    /** `emulator-<port>`, the only name adb answers to. */
    serial?: string | undefined;
}

const QEMU_COMM = /^qemu-system-/;
const EMULATOR_RANGE_START = 5554;
const EMULATOR_RANGE_END = 5682;

function readFile(path: string): string | undefined {
    try {
        return readFileSync(path, 'latin1');
    } catch {
        return undefined;
    }
}

function parentPid(pid: string, procRoot: string): string | undefined {
    const stat = readFile(join(procRoot, pid, 'stat'));
    if (stat === undefined) return undefined;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[1];
}

function environOf(pid: string, procRoot: string): Record<string, string> | undefined {
    const raw = readFile(join(procRoot, pid, 'environ'));
    if (raw === undefined) return undefined;
    const env: Record<string, string> = {};
    for (const entry of raw.split('\0')) {
        const at = entry.indexOf('=');
        if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
    }
    return env;
}

/** The pane that owns a process: the nearest ancestor still carrying `HERDR_PANE_ID`. */
function owningPane(pid: string, procRoot: string): string | undefined {
    let current: string | undefined = pid;
    for (let hops = 0; current !== undefined && current !== '0' && current !== '1' && hops < 64; hops += 1) {
        const paneId = environOf(current, procRoot)?.HERDR_PANE_ID;
        if (paneId !== undefined) return paneId;
        current = parentPid(current, procRoot);
    }
    return undefined;
}

function socketInodes(pid: string, procRoot: string): Set<string> {
    const inodes = new Set<string>();
    let names: string[];
    try {
        names = readdirSync(join(procRoot, pid, 'fd'));
    } catch {
        return inodes;
    }
    for (const name of names) {
        let link: string;
        try {
            link = readlinkSync(join(procRoot, pid, 'fd', name));
        } catch {
            continue;
        }
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
        if (inode !== undefined) inodes.add(inode);
    }
    return inodes;
}

/**
 * The emulator console port from its listen socket: an even port in the
 * emulator range held by this process. `/proc/net/tcp` is per network
 * namespace, so this only sees host-networked emulators — which is all a pane
 * can start.
 */
function consolePort(pid: string, procRoot: string): number | undefined {
    const inodes = socketInodes(pid, procRoot);
    if (inodes.size === 0) return undefined;
    const raw = readFile(join(procRoot, 'net', 'tcp'));
    if (raw === undefined) return undefined;
    for (const line of raw.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10 || fields[3] !== '0A') continue;
        const port = Number.parseInt(fields[1]?.split(':')[1] ?? '', 16);
        if (!Number.isInteger(port) || port % 2 !== 0 || port < EMULATOR_RANGE_START || port > EMULATOR_RANGE_END) continue;
        if (inodes.has(fields[9] ?? '')) return port;
    }
    return undefined;
}

/** Every emulator on this machine, attributed to its pane. */
export function scanAndroidEmulators(procRoot = '/proc'): DiscoveredEmulator[] {
    let pids: string[];
    try {
        pids = readdirSync(procRoot);
    } catch {
        return [];
    }
    const found: DiscoveredEmulator[] = [];
    for (const pid of pids) {
        if (!/^\d+$/.test(pid)) continue;
        if (!QEMU_COMM.test(readFile(join(procRoot, pid, 'comm'))?.trim() ?? '')) continue;
        const argv = (readFile(join(procRoot, pid, 'cmdline')) ?? '').split('\0').join(' ');
        const paneId = owningPane(pid, procRoot);
        if (paneId === undefined) continue;
        const portFlag = /-port (\d+)/.exec(argv)?.[1];
        const port = portFlag === undefined ? consolePort(pid, procRoot) : Number.parseInt(portFlag, 10);
        found.push({
            pid: Number(pid),
            paneId,
            ...(port === undefined ? {} : { port }),
            ...(port === undefined ? {} : { serial: `emulator-${port}` }),
        });
    }
    return found;
}

// ---------------------------------------------------------------------------
// adb
// ---------------------------------------------------------------------------

export interface AdbResult {
    stdout: string;
    stderr: string;
}

const ADB_TIMEOUT_MS = 10_000;

/** `adb` from PATH, else the standard SDK home. Never bare: every call names `-s`. */
export function findAdb(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const onPathAdb = onPath('adb', env);
    if (onPathAdb !== undefined) return onPathAdb;
    const home = env.ANDROID_HOME?.trim() || env.ANDROID_SDK_ROOT?.trim() || join(homedir(), 'Android', 'Sdk');
    const candidate = join(home, 'platform-tools', 'adb');
    try {
        statSync(candidate);
        return candidate;
    } catch {
        return undefined;
    }
}

export type AdbRunner = (args: string[], timeoutMs?: number) => Promise<AdbResult>;

export function adbRunner(adb: string): AdbRunner {
    return (args, timeoutMs = ADB_TIMEOUT_MS) => new Promise((resolve, reject) => {
        execFile(adb, args, { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
            if (error !== null) reject(error);
            else resolve({ stdout, stderr });
        });
    });
}

/** True when the shared adb daemon reports this serial as an online device. */
export async function deviceOnline(run: AdbRunner, serial: string): Promise<boolean> {
    const { stdout } = await run(['devices']);
    return stdout.split('\n').some((line) => line.startsWith(`${serial}\t`) && line.includes('\tdevice'));
}

/** The AVD name (`adb emu avd name`), with underscores back to spaces. */
export async function avdTitle(run: AdbRunner, serial: string): Promise<string | undefined> {
    try {
        const { stdout } = await run(['-s', serial, 'emu', 'avd', 'name']);
        const name = stdout.split('\n').map((line) => line.trim()).find((line) => line !== '');
        if (name === undefined || /^OK$/i.test(name)) return undefined;
        const title = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
        return title === '' ? undefined : title;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Vendored server
// ---------------------------------------------------------------------------

export const SCRCPY_SERVER_VERSION = '4.0';
const SCRCPY_JAR = 'scrcpy-server-v4.0';
const SCRCPY_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';

/** The vendored file at this path, or undefined when it is not installed here. A present file with a missing or mismatched hash throws. */
function verifiedResource(file: string, label: string): string | undefined {
    const hashFile = `${file}.sha256`;
    if (!existsSync(file) || !existsSync(hashFile)) return undefined;
    const expected = readFileSync(hashFile, 'utf8').split(/\s+/)[0]?.trim();
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (expected === undefined || expected === '' || actual !== expected) {
        throw new Error(`the vendored ${label} failed its pinned hash check`);
    }
    return file;
}

/** `resources/<parts>` from the checkout above `start`, or the packed `resources/` beside the bundle, hash-checked. */
export function resolveVendoredResource(parts: string[], label: string, start = dirname(fileURLToPath(import.meta.url))): string {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
        const verified = verifiedResource(join(dir, 'resources', ...parts), label);
        if (verified !== undefined) return verified;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // The packed artifact lays `resources/` beside the host bundle.
    const packed = verifiedResource(join(start, 'resources', ...parts), label);
    if (packed !== undefined) return packed;
    throw new Error(`the vendored ${label} is not installed`);
}

export function resolveScrcpyServer(start = dirname(fileURLToPath(import.meta.url))): string {
    return resolveVendoredResource(['scrcpy', SCRCPY_JAR], 'scrcpy server', start);
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/** Announce an emulator only once it stays put; withdraw it with grace. */
const ANDROID_ANNOUNCE_AFTER_MS = 1500;
const ANDROID_WITHDRAW_AFTER_MS = 3000;

interface AndroidPaneState {
    candidate: { serial: string; title: string | undefined; firstSeen: number } | undefined;
    announced: PreviewPresence | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
}

/** The kinds a device mirror announces. */
export type DevicePreviewKind = Extract<PreviewPresence['kind'], 'android' | 'ios'>;

/**
 * Discovered devices → one announced presence of this tracker's kind per pane.
 * Hysteresis, so a device restart does not flicker the chip.
 */
export class DevicePresenceTracker {
    private readonly kind: DevicePreviewKind;
    private readonly announceAfterMs: number;
    private readonly withdrawAfterMs: number;
    private readonly now: () => number;
    private readonly panes = new Map<string, AndroidPaneState>();
    private readonly listeners = new Set<(paneId: string) => void>();

    constructor(options: { kind?: DevicePreviewKind; announceAfterMs?: number; withdrawAfterMs?: number; now?: () => number } = {}) {
        this.kind = options.kind ?? 'android';
        this.announceAfterMs = options.announceAfterMs ?? ANDROID_ANNOUNCE_AFTER_MS;
        this.withdrawAfterMs = options.withdrawAfterMs ?? ANDROID_WITHDRAW_AFTER_MS;
        this.now = options.now ?? Date.now;
    }

    previewFor(paneId: string): PreviewPresence | undefined {
        return this.panes.get(paneId)?.announced;
    }

    onChange(listener: (paneId: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** True when the announced presence changed and the host should push it. */
    update(known: Map<string, { serial: string; title: string | undefined }>): boolean {
        let changed = false;
        for (const [paneId, emulator] of known) {
            if (this.consider(paneId, emulator)) changed = true;
        }
        for (const paneId of [...this.panes.keys()]) {
            if (!known.has(paneId) && this.lost(paneId)) changed = true;
        }
        return changed;
    }

    release(paneId: string): boolean {
        const state = this.panes.get(paneId);
        if (state === undefined) return false;
        if (state.timer !== undefined) clearTimeout(state.timer);
        this.panes.delete(paneId);
        if (state.announced === undefined) return false;
        this.emit(paneId);
        return true;
    }

    stop(): void {
        for (const state of this.panes.values()) {
            if (state.timer !== undefined) clearTimeout(state.timer);
            state.timer = undefined;
        }
    }

    private consider(paneId: string, emulator: { serial: string; title: string | undefined }): boolean {
        let state = this.panes.get(paneId);
        if (state === undefined) {
            state = { candidate: undefined, announced: undefined, timer: undefined };
            this.panes.set(paneId, state);
        }
        const announced = state.announced;
        if (announced !== undefined && announced.kind === this.kind) {
            if (announced.title !== emulator.title) {
                state.announced = emulator.title === undefined
                    ? { kind: this.kind, since: announced.since }
                    : { kind: this.kind, title: emulator.title, since: announced.since };
                this.emit(paneId);
                return true;
            }
            state.candidate = undefined;
            return false;
        }
        const firstSeen = state.candidate?.serial === emulator.serial ? state.candidate.firstSeen : this.now();
        state.candidate = { ...emulator, firstSeen };
        if (this.now() - firstSeen < this.announceAfterMs) {
            if (state.timer === undefined) {
                const wait = this.announceAfterMs - (this.now() - firstSeen);
                state.timer = setTimeout(() => {
                    state.timer = undefined;
                    this.announce(paneId);
                }, Math.max(wait, 0));
                state.timer.unref?.();
            }
            return false;
        }
        return this.announce(paneId);
    }

    private lost(paneId: string): boolean {
        const state = this.panes.get(paneId);
        if (state === undefined || state.announced === undefined) {
            if (state !== undefined) state.candidate = undefined;
            return false;
        }
        state.candidate = undefined;
        if (state.timer === undefined) {
            state.timer = setTimeout(() => {
                state.timer = undefined;
                const current = this.panes.get(paneId);
                if (current !== undefined) current.announced = undefined;
                this.emit(paneId);
            }, this.withdrawAfterMs);
            state.timer.unref?.();
        }
        return false;
    }

    private announce(paneId: string): boolean {
        const state = this.panes.get(paneId);
        const candidate = state?.candidate;
        if (state === undefined || candidate === undefined) return false;
        state.candidate = undefined;
        state.announced = candidate.title === undefined
            ? { kind: this.kind, since: candidate.firstSeen }
            : { kind: this.kind, title: candidate.title, since: candidate.firstSeen };
        this.emit(paneId);
        return true;
    }

    private emit(paneId: string): void {
        for (const listener of this.listeners) listener(paneId);
    }
}

// ---------------------------------------------------------------------------
// Engine seam (the encoded source)
// ---------------------------------------------------------------------------

/** One forwarded control message, as the engine emits it on `session.input`. */
export type EncodedInput =
    | { kind: 'pointer'; phase: 'down' | 'up' | 'move' | 'cancel'; x: number; y: number }
    | { kind: 'wheel'; dx: number; dy: number }
    | { kind: 'key'; name?: string; character?: string; down: boolean; modifiers?: string[] }
    | { kind: 'text'; text: string }
    | { kind: 'release_all' };

export type EncodedEngineEvent =
    | { kind: 'keyframeRequest' }
    | { kind: 'input'; input: EncodedInput };

export interface EncodedEngineSession {
    sessionId: string;
    generation: number;
    geometry: DesktopSurfaceGeometry;
    source: { kind: string; width: number; height: number; origin: { x: number; y: number } };
}

/**
 * The slice of the engine one mirror needs. The default implementation speaks
 * the local protocol through `EngineClient.request` — public exactly so a
 * consumer can add a capability the typed helpers do not cover yet — while
 * tests substitute a fake at this boundary.
 */
export interface EncodedEngineOptions {
    maxFps?: number;
    loopbackTcp?: boolean;
}

export interface EncodedEngine {
    open(width: number, height: number, permissions: DesktopPermission[], options?: EncodedEngineOptions): Promise<EncodedEngineSession>;
    feed(keyframe: boolean, data: Buffer): Promise<void>;
    answer(sdp: string): Promise<{ accepted: boolean }>;
    candidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): Promise<{ accepted: boolean }>;
    /** Signaling the live listener already consumed is filtered out here. */
    drainSignaling(): Array<{ kind: 'offer' | 'candidate' | 'state' | 'revoked'; [key: string]: unknown }>;
    onLive(listener: (event: EncodedEngineEvent) => void): void;
    close(): Promise<void>;
    stop(): Promise<void>;
}

interface RawEngineEvent {
    event: string;
    params: { sessionId?: string; generation?: number; input?: EncodedInput; [key: string]: unknown };
}

export interface DesklinkEncodedEngineOptions {
    enginePath?: string;
    onDiagnostic?: (line: string) => void;
}

export class DesklinkEncodedEngine implements EncodedEngine {
    private readonly options: DesklinkEncodedEngineOptions;
    private client: EngineClient | null = null;
    private session: EncodedEngineSession | null = null;
    private live: ((event: EncodedEngineEvent) => void) | null = null;
    private readonly consumed = new Set<unknown>();

    constructor(options: DesklinkEncodedEngineOptions = {}) {
        this.options = options;
    }

    async open(width: number, height: number, permissions: DesktopPermission[], options: EncodedEngineOptions = {}): Promise<EncodedEngineSession> {
        const resolved = resolveEngine(this.options.enginePath);
        if (resolved === null) throw new EngineRefused('desktop-unavailable', 'the desktop engine is unavailable');
        // The pinned npm client predates the encoded source, so the open goes
        // over the generic request with the engine's own wire shape.
        const client = await EngineClient.start(resolved.command, resolved.args, {
            ...(this.options.onDiagnostic === undefined ? {} : { onDiagnostic: this.options.onDiagnostic }),
            onEvent: (event) => this.handleLive(event as unknown as RawEngineEvent),
        });
        this.client = client;
        try {
            const opened = await client.openSession({
                source: { kind: 'encoded', codec: 'h264', width, height } as never,
                permissions,
                // Sizes and bitrate are the stream's own for this source and
                // stay unset; the fps cap and loopback TCP still apply.
                ...(options.maxFps === undefined ? {} : { maxFps: options.maxFps }),
                ...(options.loopbackTcp === true ? { loopbackTcp: true } : {}),
            }) as unknown as EncodedEngineSession;
            this.session = opened;
            return opened;
        } catch (error) {
            // An engine without the encoded source (the pinned 0.1.1) refuses:
            // never leave its process behind to retry against.
            this.client = null;
            await client.stop().catch(() => undefined);
            throw error;
        }
    }

    async feed(keyframe: boolean, data: Buffer): Promise<void> {
        if (this.client === null || this.session === null) return;
        await this.client.request('session.feed', {
            session_id: this.session.sessionId,
            keyframe,
            data_b64: data.toString('base64'),
        });
    }

    async answer(sdp: string): Promise<{ accepted: boolean }> {
        if (this.client === null || this.session === null) throw new EngineRefused('session', 'that desktop session is not open');
        return this.client.acceptAnswer(this.session.sessionId, this.session.generation, sdp);
    }

    async candidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): Promise<{ accepted: boolean }> {
        if (this.client === null || this.session === null) throw new EngineRefused('session', 'that desktop session is not open');
        return this.client.addCandidate(this.session.sessionId, this.session.generation, candidate, sdpMid, sdpMLineIndex);
    }

    drainSignaling(): Array<{ kind: 'offer' | 'candidate' | 'state' | 'revoked'; [key: string]: unknown }> {
        if (this.client === null || this.session === null) return [];
        const out: Array<{ kind: 'offer' | 'candidate' | 'state' | 'revoked'; [key: string]: unknown }> = [];
        for (const event of this.client.drainEvents(this.session.sessionId)) {
            if (this.consumed.has(event)) {
                this.consumed.delete(event);
                continue;
            }
            const raw = event as unknown as RawEngineEvent;
            if (raw.event === 'session.description') {
                const description = (raw.params as { description?: { sdp?: string } }).description;
                out.push({ kind: 'offer', generation: Number(raw.params.generation ?? 0), sdp: String(description?.sdp ?? '') });
            } else if (raw.event === 'session.candidate') {
                const params = raw.params as { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown; generation?: unknown };
                out.push({
                    kind: 'candidate',
                    generation: Number(params.generation ?? 0),
                    candidate: String(params.candidate ?? ''),
                    sdpMid: (params.sdpMid as string | null) ?? null,
                    sdpMLineIndex: (params.sdpMLineIndex as number | null) ?? null,
                });
            } else if (raw.event === 'session.state') {
                const params = raw.params as { capture?: unknown; transport?: unknown; firstFrame?: unknown };
                out.push({
                    kind: 'state',
                    capture: String(params.capture ?? 'unknown'),
                    transport: String(params.transport ?? 'unknown'),
                    firstFrame: params.firstFrame === true,
                });
            } else if (raw.event === 'session.revoked') {
                out.push({ kind: 'revoked', reason: String((raw.params as { reason?: unknown }).reason ?? 'the desktop session ended') });
            }
        }
        return out;
    }

    onLive(listener: (event: EncodedEngineEvent) => void): void {
        this.live = listener;
    }

    async close(): Promise<void> {
        if (this.client !== null && this.session !== null) {
            const client = this.client;
            const sessionId = this.session.sessionId;
            this.session = null;
            client.drainEvents(sessionId);
            await client.closeSession(sessionId).catch(() => undefined);
        }
    }

    async stop(): Promise<void> {
        const client = this.client;
        this.client = null;
        this.session = null;
        await client?.stop().catch(() => undefined);
    }

    private handleLive(event: RawEngineEvent): void {
        if (this.session === null || event.params.sessionId !== this.session.sessionId) return;
        if (event.event === 'session.keyframeRequest') {
            this.consumed.add(event);
            this.live?.({ kind: 'keyframeRequest' });
        } else if (event.event === 'session.input' && event.params.input !== undefined) {
            this.consumed.add(event);
            this.live?.({ kind: 'input', input: event.params.input });
        }
    }
}

// ---------------------------------------------------------------------------
// Mirrors: one scrcpy server per watched emulator
// ---------------------------------------------------------------------------

export interface AndroidMirrorOptions {
    adb: string;
    runAdb?: AdbRunner;
    makeEngine?: (options: DesklinkEncodedEngineOptions) => EncodedEngine;
    enginePath?: string;
    onDiagnostic?: (line: string) => void;
    /** How long the first size packet may take after the server starts. */
    startTimeoutMs?: number;
}

const SERVER_START_TIMEOUT_MS = 15_000;
/** Feeds that may be inside the engine at once; newer frames win over backlog. */
const MAX_INFLIGHT_FEEDS = 3;
/** The phone watches at most this; the device encodes no more than asked. */
const MIRROR_BIT_RATE = 2_000_000;
const MIRROR_MAX_FPS = 60;

interface LiveMirror {
    serial: string;
    width: number;
    height: number;
    engine: EncodedEngine;
    session: EncodedEngineSession;
    video: Socket;
    control: Socket;
    server: ChildProcess;
    forwardPort: number;
    runAdb: AdbRunner;
    inflight: number;
    fingerDown: boolean;
    lastX: number;
    lastY: number;
    closed: boolean;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server: Server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => {
                if (address !== null && typeof address === 'object') resolve(address.port);
                else reject(new Error('no local port for the scrcpy forward'));
            });
        });
    });
}

/**
 * One permanent listener per socket, so coalesced TCP segments are never
 * lost between reads. (`socket.unshift` across sequential reads drops data
 * when a fresh segment lands first — the usual case on loopback.)
 */
interface SocketReader {
    read(count: number, timeoutMs: number): Promise<Buffer>;
    /** Whatever has arrived, waiting for at least one byte. Never empty. */
    next(timeoutMs: number): Promise<Buffer>;
    /**
     * The first `count` bytes without consuming them: proves the server is
     * behind the forward while leaving every byte for the real reads.
     */
    peek(count: number, timeoutMs: number): Promise<Buffer>;
    /** Stop listening; anything unread comes back for the pump to parse. */
    detach(): Buffer;
}

function createSocketReader(socket: Socket, prefix: Buffer = Buffer.alloc(0)): SocketReader {
    let stash = prefix;
    let ended = false;
    let failed: Error | undefined;
    const waiters: Array<{
        count: number;
        consume: boolean;
        resolve: (data: Buffer) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];
    const serve = (): void => {
        for (;;) {
            const waiter = waiters[0];
            if (waiter === undefined) return;
            if (stash.length >= waiter.count) {
                waiters.shift();
                clearTimeout(waiter.timer);
                const out = stash.subarray(0, waiter.count);
                if (waiter.consume) stash = stash.subarray(waiter.count);
                waiter.resolve(out);
            } else if (ended || failed !== undefined) {
                waiters.shift();
                clearTimeout(waiter.timer);
                waiter.reject(failed ?? new Error('the scrcpy stream ended before it began'));
            } else {
                return;
            }
        }
    };
    const onData = (chunk: Buffer): void => {
        stash = Buffer.concat([stash, chunk]);
        serve();
    };
    const onEnd = (error?: Error): void => {
        if (error !== undefined) failed = error;
        else ended = true;
        serve();
    };
    socket.on('data', onData);
    socket.once('close', () => onEnd());
    socket.once('error', (error) => onEnd(error instanceof Error ? error : new Error(String(error))));
    const wait = (count: number, consume: boolean, timeoutMs: number): Promise<Buffer> => new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const at = waiters.findIndex((waiter) => waiter.resolve === resolve);
                if (at >= 0) waiters.splice(at, 1);
                reject(new Error('timed out waiting for the scrcpy stream'));
            }, timeoutMs);
            waiters.push({ count, consume, resolve, reject, timer });
            serve();
        });
    return {
        read: (count, timeoutMs) => wait(count, true, timeoutMs),
        next: async (timeoutMs) => {
            // One byte is enough for the parser to make progress; exact
            // framing is its job, not the socket's.
            const first = await wait(1, true, timeoutMs);
            const rest = stash;
            stash = Buffer.alloc(0);
            return Buffer.concat([first, rest]);
        },
        peek: (count, timeoutMs) => wait(count, false, timeoutMs),
        detach: () => {
            socket.off('data', onData);
            const rest = stash;
            stash = Buffer.alloc(0);
            return rest;
        },
    };
}

/**
 * One scrcpy server on one emulator, feeding one encoded engine session.
 * Created lazily when a phone watches: no watcher, no engine, no link bytes.
 */
export class AndroidMirrors {
    private readonly options: AndroidMirrorOptions;
    private readonly runAdb: AdbRunner;
    private readonly mirrors = new Map<string, LiveMirror>();
    /** Opens in flight: two phones tapping Watch at once share one mirror. */
    private readonly opening = new Map<string, Promise<{ session: EncodedEngineSession; width: number; height: number }>>();

    constructor(options: AndroidMirrorOptions) {
        this.options = options;
        this.runAdb = options.runAdb ?? adbRunner(options.adb);
    }

    has(serial: string): boolean {
        return this.mirrors.has(serial);
    }

    async open(
        serial: string,
        request: { permissions: DesktopPermission[]; maxFps?: number; loopbackTcp?: boolean },
    ): Promise<{ session: EncodedEngineSession; width: number; height: number }> {
        const existing = this.mirrors.get(serial);
        if (existing !== undefined && !existing.closed) {
            return { session: existing.session, width: existing.width, height: existing.height };
        }
        const inflight = this.opening.get(serial);
        if (inflight !== undefined) return inflight;
        const opening = this.start(serial, request).finally(() => {
            if (this.opening.get(serial) === opening) this.opening.delete(serial);
        });
        this.opening.set(serial, opening);
        return opening;
    }

    private async start(
        serial: string,
        request: { permissions: DesktopPermission[]; maxFps?: number; loopbackTcp?: boolean },
    ): Promise<{ session: EncodedEngineSession; width: number; height: number }> {
        const jar = resolveScrcpyServer();
        const timeout = this.options.startTimeoutMs ?? SERVER_START_TIMEOUT_MS;
        if (!await deviceOnline(this.runAdb, serial).catch(() => false)) {
            throw new EngineRefused('desktop-unavailable', 'the emulator is not reachable');
        }
        await this.runAdb(['-s', serial, 'push', jar, SCRCPY_DEVICE_PATH], timeout);
        const port = await freePort();
        // The server parses this with Integer.parseInt(hex): it must fit a
        // signed 32-bit int, or the server dies before it listens.
        const scid = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
        await this.runAdb(['-s', serial, 'forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`], timeout);
        const server = spawn(this.options.adb, [
            '-s', serial, 'shell',
            `CLASSPATH=${SCRCPY_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_SERVER_VERSION}`,
            // cleanup=false: the server unlinks its own jar on exit by
            // default, which races the next open's push. The jar is ours
            // to manage; one push overwrites it every time.
            `tunnel_forward=true scid=${scid} video=true audio=false control=true cleanup=false`,
            `video_bit_rate=${MIRROR_BIT_RATE} max_fps=${MIRROR_MAX_FPS}`,
        ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        server.unref();
        server.stdout?.on('data', (chunk: Buffer) => this.options.onDiagnostic?.(`mirror server out: ${chunk.toString().slice(0, 200)}`));
        server.stderr?.on('data', (chunk: Buffer) => this.options.onDiagnostic?.(`mirror server err: ${chunk.toString().slice(0, 200)}`));
        const fail = async (message: string): Promise<never> => {
            server.kill('SIGKILL');
            await this.runAdb(['-s', serial, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined);
            throw new EngineRefused('desktop-unavailable', message);
        };
        // The forward accepts TCP before the server listens, so a bare
        // connect proves nothing: the socket may be dead on arrival. Only
        // the server's first video byte proves it is behind the forward —
        // and that byte is handed to the reader instead of being consumed
        // here. The control socket sends no opening byte at all (v4.0
        // `DesktopConnection` spends its one dummy byte on the first accept,
        // the video one), so a control connect that stays up IS the proof:
        // the forward refuses while no server listens, and the server takes
        // its video accept before its control one.
        const connectLoopback = (timeoutMs: number, waitForFirstByte: boolean): Promise<{ socket: Socket; reader: SocketReader }> => {
            const deadline = Date.now() + timeoutMs;
            let current: Socket | undefined;
            const overall = setTimeout(() => {
                current?.destroy();
                overallReject(new Error('the scrcpy socket stayed silent'));
            }, timeoutMs);
            let overallReject: (error: Error) => void = () => undefined;
            const overallDone = new Promise<never>((_, reject) => {
                overallReject = reject;
            });
            const attempt = (): Promise<{ socket: Socket; reader: SocketReader }> => new Promise((resolve, reject) => {
                const socket = connect(port, '127.0.0.1');
                current = socket;
                // Error then close fire for one dying socket: without the
                // guard the retry forks, and the twin steals the server's
                // other accept from under the real channel.
                let settled = false;
                const retry = (error: Error): void => {
                    if (settled) return;
                    settled = true;
                    socket.destroy();
                    if (Date.now() >= deadline) {
                        clearTimeout(overall);
                        reject(error);
                    }
                    // Ref'd on purpose: this chain is awaited, and an unref'd
                    // wait lets the loop drain with the open still pending.
                    else setTimeout(() => attempt().then(resolve, reject), 200);
                };
                const onError = (error: Error): void => {
                    retry(error instanceof Error ? error : new Error(String(error)));
                };
                const onClose = (): void => {
                    retry(new Error('the scrcpy socket closed before the server answered'));
                };
                socket.once('error', onError);
                socket.once('close', onClose);
                // A connected socket is waited out to the deadline, never
                // destroyed for quietness: on a loaded host the server can
                // take seconds to answer, and killing the socket can take
                // down the server accept it was about to complete.
                socket.once('connect', () => {
                    // The permanent consumer attaches before the first byte
                    // is read: a connected socket nobody listens to drops
                    // what arrives, which starved the video pump under load
                    // while it waited out the control connect.
                    const reader = createSocketReader(socket);
                    if (!waitForFirstByte) {
                        settled = true;
                        clearTimeout(overall);
                        socket.removeListener('error', onError);
                        socket.removeListener('close', onClose);
                        resolve({ socket, reader });
                        return;
                    }
                    void reader.peek(1, Math.max(deadline - Date.now(), 1)).then(
                        () => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(overall);
                            socket.removeListener('error', onError);
                            socket.removeListener('close', onClose);
                            resolve({ socket, reader });
                        },
                        () => retry(new Error('the scrcpy socket stayed silent')),
                    );
                });
            });
            return Promise.race([attempt(), overallDone]);
        };
        let video: Socket;
        let videoReader: SocketReader;
        try {
            const connected = await connectLoopback(timeout, true);
            video = connected.socket;
            videoReader = connected.reader;
        } catch {
            await fail('the emulator did not start its mirror');
        }
        // Both sockets connect before anything is read: the server only
        // starts streaming once it has accepted every socket it serves.
        let control: Socket;
        let controlReader: SocketReader;
        try {
            const connected = await connectLoopback(timeout, false);
            control = connected.socket;
            controlReader = connected.reader;
        } catch {
            video!.destroy();
            await fail('the emulator sent no control channel');
        }
        // The pump starts before anything else reads: a server whose video
        // nobody drains stops streaming within seconds, so the socket is
        // read continuously from here on, including across the engine open.
        // Media that arrives before the engine session exists is buffered
        // for the flush below; the SPS in it is what the offer negotiates
        // from. Newest wins past the bound; config and key frames always do.
        const parser = new ScrcpyVideoParser();
        const openingMedia: Array<{ keyframe: boolean; payload: Buffer }> = [];
        const sizeState: { width: number; height: number } = { width: 0, height: 0 };
        let pumpFailed: unknown = null;
        const drainVideo = async (): Promise<void> => {
            try {
                // The dummy byte, the device name and the codec id come
                // first; the parser throws on anything but H.264.
                parser.push(await videoReader.read(1 + 64, timeout));
                parser.push(await videoReader.read(4, timeout));
                // Past the preamble, whatever arrives: fixed-size reads
                // would stall on a short tail while the parser still needs
                // fewer bytes than one more grab.
                for (;;) {
                    for (const event of parser.push(await videoReader.next(timeout))) {
                        if (event.type === 'size') {
                            sizeState.width = event.width;
                            sizeState.height = event.height;
                            sizeListener?.(event.width, event.height);
                        } else if (drainTarget === null) {
                            if (openingMedia.length >= 90 && !event.keyframe && !event.config) continue;
                            openingMedia.push({ keyframe: event.keyframe, payload: event.payload });
                        } else {
                            drainTarget(event);
                        }
                    }
                }
            } catch (error) {
                pumpFailed = error;
            }
        };
        // Null until the engine session exists: the pump buffers, then hands
        // each unit to this. Rotations re-target touches the same way.
        let drainTarget: ((event: Extract<ScrcpyVideoEvent, { type: 'media' }>) => void) | null = null;
        let sizeListener: ((width: number, height: number) => void) | null = null;
        const draining = drainVideo();
        const deadline = Date.now() + timeout;
        while (sizeState.width === 0 && pumpFailed === null) {
            if (Date.now() > deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (sizeState.width === 0) {
            video!.destroy();
            await draining;
            await fail(pumpFailed instanceof Error ? pumpFailed.message : 'the emulator sent no video');
        }
        const width = sizeState.width;
        const height = sizeState.height;
        const makeEngine = this.options.makeEngine ?? ((engineOptions) => new DesklinkEncodedEngine(engineOptions));
        const engine = makeEngine({
            ...(this.options.enginePath === undefined ? {} : { enginePath: this.options.enginePath }),
            ...(this.options.onDiagnostic === undefined ? {} : { onDiagnostic: this.options.onDiagnostic }),
        });
        let session: EncodedEngineSession;
        try {
            session = await engine.open(width, height, request.permissions, {
                ...(request.maxFps === undefined ? {} : { maxFps: request.maxFps }),
                ...(request.loopbackTcp === true ? { loopbackTcp: true } : {}),
            });
        } catch (error) {
            video!.destroy();
            await fail(error instanceof Error ? error.message : 'the live view did not start');
        }
        // Nothing is ever read back off control: the server sends no opening
        // byte and no replies, so the reader just detaches.
        controlReader!.detach();
        const mirror: LiveMirror = {
            serial,
            width,
            height,
            engine,
            session: session!,
            video: video!,
            control: control!,
            server,
            forwardPort: port,
            runAdb: this.runAdb,
            inflight: 0,
            fingerDown: false,
            lastX: Math.floor(width / 2),
            lastY: Math.floor(height / 2),
            closed: false,
        };
        this.mirrors.set(serial, mirror);
        engine.onLive((event) => {
            if (mirror.closed) return;
            if (event.kind === 'keyframeRequest') {
                // "Reset the video stream": the encoder answers with a new SPS + IDR.
                control!.write(RESET_VIDEO_MESSAGE);
                return;
            }
            this.applyInput(mirror, event.input);
        });
        const scheduleFeed = (keyframe: boolean, payload: Buffer): void => {
            if (mirror.inflight >= MAX_INFLIGHT_FEEDS) return;
            mirror.inflight += 1;
            engine.feed(keyframe, toAccessUnit(payload)).catch(() => undefined).finally(() => {
                mirror.inflight -= 1;
            });
        };
        // A rotation restarts the encoder at a new size. The open geometry
        // stays (the client aimed at it), but touches map to the pixels the
        // device has now.
        mirror.width = sizeState.width;
        mirror.height = sizeState.height;
        sizeListener = (width, height) => {
            mirror.width = width;
            mirror.height = height;
        };
        drainTarget = (event) => scheduleFeed(event.keyframe, event.payload);
        // The opening burst goes in order, awaited: the SPS and its IDR are
        // what the offer negotiates from, so they must not lose to the cap.
        for (const unit of openingMedia.splice(0)) {
            if (mirror.closed) break;
            await engine.feed(unit.keyframe, toAccessUnit(unit.payload)).catch(() => undefined);
        }
        const teardown = (): void => {
            void this.close(serial).catch(() => undefined);
        };
        video!.once('close', teardown);
        video!.once('error', teardown);
        control!.once('close', teardown);
        control!.once('error', teardown);
        return { session: session!, width, height };
    }

    /** Engine input → the device's own touch, keys and clipboard refusal. */
    applyInput(mirror: LiveMirror, input: EncodedInput): void {
        if (mirror.closed) return;
        const write = (data: Buffer): void => {
            mirror.control.write(data);
        };
        switch (input.kind) {
            case 'pointer': {
                const x = Math.max(0, Math.min(mirror.width - 1, Math.round(input.x)));
                const y = Math.max(0, Math.min(mirror.height - 1, Math.round(input.y)));
                mirror.lastX = x;
                mirror.lastY = y;
                if (input.phase === 'down') {
                    mirror.fingerDown = true;
                    write(encodeTouch(ANDROID_TOUCH_DOWN, x, y, mirror.width, mirror.height));
                } else if (input.phase === 'up' || input.phase === 'cancel') {
                    mirror.fingerDown = false;
                    write(encodeTouch(input.phase === 'up' ? ANDROID_TOUCH_UP : ANDROID_TOUCH_CANCEL, x, y, mirror.width, mirror.height));
                } else if (mirror.fingerDown) {
                    write(encodeTouch(ANDROID_TOUCH_MOVE, x, y, mirror.width, mirror.height));
                }
                return;
            }
            case 'wheel': {
                write(encodeScroll(mirror.lastX, mirror.lastY, mirror.width, mirror.height, input.dx, input.dy));
                return;
            }
            case 'text': {
                if (input.text !== '') write(encodeText(input.text));
                return;
            }
            case 'release_all': {
                if (mirror.fingerDown) {
                    mirror.fingerDown = false;
                    write(encodeTouch(ANDROID_TOUCH_UP, mirror.lastX, mirror.lastY, mirror.width, mirror.height));
                }
                return;
            }
            case 'key': {
                const key = this.deviceKey(input);
                if (key !== undefined) write(key);
                return;
            }
        }
    }

    /**
     * The preview toolbar's device keys (old device-key surface, P1.5's
     * client half): Ctrl+Backspace wakes or goes back, Ctrl+H goes home,
     * Ctrl+O opens recents, Ctrl+Left rotates. Anything else is not a device
     * key and is ignored in v1.
     */
    deviceKey(input: Extract<EncodedInput, { kind: 'key' }>): Buffer | undefined {
        const control = (input.modifiers ?? []).some((modifier) => modifier.toLowerCase() === 'control');
        if (!control) return undefined;
        const action = input.down ? ANDROID_ACTION_DOWN : ANDROID_ACTION_UP;
        if (input.name === 'Backspace') return encodeBackOrScreenOn(action);
        if (input.name === 'ArrowLeft') return input.down ? ROTATE_DEVICE_MESSAGE : undefined;
        if (input.character === 'h') return encodeInjectKeycode(action, ANDROID_KEYCODE_HOME);
        if (input.character === 'o') return encodeInjectKeycode(action, ANDROID_KEYCODE_APP_SWITCH);
        return undefined;
    }

    engineFor(serial: string): EncodedEngine | undefined {
        const mirror = this.mirrors.get(serial);
        return mirror === undefined || mirror.closed ? undefined : mirror.engine;
    }

    async close(serial: string): Promise<void> {
        // A close that lands mid-open waits it out: `start` registers the
        // mirror before its promise settles, so this always finds it.
        const inflight = this.opening.get(serial);
        if (inflight !== undefined) await inflight.catch(() => undefined);
        const mirror = this.mirrors.get(serial);
        if (mirror === undefined) return;
        this.mirrors.delete(serial);
        mirror.closed = true;
        mirror.video.destroy();
        mirror.control.destroy();
        if (mirror.server.exitCode === null) mirror.server.kill('SIGKILL');
        await mirror.engine.close().catch(() => undefined);
        await mirror.engine.stop().catch(() => undefined);
        // The device server exits when its sockets close; the forward is ours
        // to remove either way, on the shared daemon, by our port only.
        await mirror.runAdb(['-s', serial, 'forward', '--remove', `tcp:${mirror.forwardPort}`]).catch(() => undefined);
    }

    async closeAll(): Promise<void> {
        for (const serial of [...this.mirrors.keys()]) await this.close(serial);
    }
}

// ---------------------------------------------------------------------------
// Targets: desktop.* by session, for headless emulators
// ---------------------------------------------------------------------------

/** What a target router needs from a source's mirrors: one live mirror per device. */
export interface DeviceMirrors {
    open(
        serial: string,
        request: { permissions: DesktopPermission[]; maxFps?: number; loopbackTcp?: boolean },
    ): Promise<{ session: EncodedEngineSession; width: number; height: number }>;
    engineFor(serial: string): EncodedEngine | undefined;
    close(serial: string): Promise<void>;
    closeAll(): Promise<void>;
}

export interface DeviceTargetsOptions {
    /** The presence kind this router opens; any other kind is not its session. */
    kind?: DevicePreviewKind;
    mirrors: DeviceMirrors;
    listSessions: () => Promise<Array<{ id: string; paneId?: string }>>;
    previewFor: (paneId: string) => PreviewPresence | undefined;
    /** The confirmed device behind an announced pane (adb serial, simulator UDID); the map is the grant. */
    serialForPane: (paneId: string) => string | undefined;
    lease?: PreviewLeaseTracker;
}

/** Handle prefixes per kind, so answer/candidate/poll/close route back to the right router. */
const TARGET_PREFIX: Record<DevicePreviewKind, string> = { android: 'av', ios: 'is' };

/**
 * A device's H.264 offered as Constrained Baseline. Android's WebRTC decoder
 * factory negotiates High only on Qualcomm and Exynos decoders, so a High
 * offer (the iOS Simulator's VideoToolbox stream) fails before a frame on
 * every other phone and the emulator, though their decoders play it.
 * ponytail: label only; a phone whose decoder truly lacks High shows nothing.
 */
function offeredAsBaseline(sdp: string): string {
    return sdp.replace(/profile-level-id=64[0-9a-f]{4}/gi, 'profile-level-id=42e01f');
}

/**
 * Routes `desktop.* { target }` at one kind of device mirror (headless
 * emulators, claimed simulators). Handles carry the kind's prefix so later
 * answer/candidate/poll/close route back here and never at the Computer
 * session; the prefix alone grants nothing, the map does.
 */
export class DevicePreviewTargets {
    readonly kind: DevicePreviewKind;
    private readonly prefix: string;
    private readonly mirrors: DeviceMirrors;
    private readonly listSessions: () => Promise<Array<{ id: string; paneId?: string }>>;
    private readonly previewFor: (paneId: string) => PreviewPresence | undefined;
    private readonly serialForPane: (paneId: string) => string | undefined;
    private readonly lease: PreviewLeaseTracker | undefined;
    private readonly serialByTarget = new Map<string, { serial: string; paneId: string; controlling: boolean; ownerDeviceId?: string }>();
    private readonly connectedLinkDevices = new Set<string>();
    private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private counter = 0;

    constructor(options: DeviceTargetsOptions) {
        this.kind = options.kind ?? 'android';
        this.prefix = TARGET_PREFIX[this.kind];
        this.mirrors = options.mirrors;
        this.listSessions = options.listSessions;
        this.previewFor = options.previewFor;
        this.serialForPane = options.serialForPane;
        this.lease = options.lease;
    }

    /** The pane's device for a session, or a refusal when it cannot be shown. */
    async resolveTarget(sessionId: string): Promise<{ paneId: string; serial: string }> {
        const missing = this.kind === 'ios' ? 'that session has no simulator to watch' : 'that session has no emulator to watch';
        const sessions = await this.listSessions();
        const paneId = sessions.find((session) => session.id === sessionId)?.paneId;
        const preview = paneId === undefined ? undefined : this.previewFor(paneId);
        if (paneId === undefined || preview?.kind !== this.kind) {
            // Mandatory for device opens: never fall back to the whole desktop.
            throw new EngineRefused('permission-denied', missing);
        }
        // The serial is the discovery's; the tracker only announces panes the
        // watcher confirmed, so a serial exists for every announced pane.
        const serial = this.serialForPane(paneId);
        if (serial === undefined) throw new EngineRefused('permission-denied', missing);
        return { paneId, serial };
    }

    async openTarget(
        sessionId: string,
        request: { permissions: DesktopPermission[]; maxFps?: number; loopbackTcp?: boolean },
        owner?: { deviceId?: string },
    ): Promise<{ desktopId: string; generation: number; geometry: DesktopSurfaceGeometry; source: EncodedEngineSession['source'] }> {
        const { paneId, serial } = await this.resolveTarget(sessionId);
        const { session } = await this.mirrors.open(serial, request);
        this.counter += 1;
        const desktopId = `${this.prefix}${this.counter.toString(36)}`;
        const controlling = request.permissions.includes('control');
        this.serialByTarget.set(desktopId, {
            serial,
            paneId,
            controlling,
            ...(owner?.deviceId === undefined ? {} : { ownerDeviceId: owner.deviceId }),
        });
        if (controlling) this.lease?.markControl(paneId, desktopId, owner?.deviceId);
        return { desktopId, generation: session.generation, geometry: session.geometry, source: session.source };
    }

    /** A client handle from this router's open, never a Computer handle. */
    owns(desktopId: string): boolean {
        return desktopId.startsWith(this.prefix) && this.serialByTarget.has(desktopId);
    }

    private requiredTarget(desktopId: string, connectionId?: string, deviceId?: string): { serial: string; paneId: string; controlling: boolean; ownerDeviceId?: string } {
        const target = this.serialByTarget.get(desktopId);
        if (target === undefined) throw new EngineRefused('session', 'that desktop session is not open');
        if (connectionId !== undefined && (deviceId === undefined || target.ownerDeviceId !== deviceId)) {
            throw new EngineRefused('session', 'that desktop session belongs to another device');
        }
        return target;
    }

    private require(desktopId: string, connectionId?: string, deviceId?: string): EncodedEngine {
        const target = this.requiredTarget(desktopId, connectionId, deviceId);
        const engine = this.mirrors.engineFor(target.serial);
        if (engine === undefined) throw new EngineRefused('session', 'that desktop session is not open');
        return engine;
    }

    async answer(desktopId: string, sdp: string, connectionId?: string, deviceId?: string): Promise<{ accepted: boolean }> {
        const accepted = await this.require(desktopId, connectionId, deviceId).answer(sdp);
        const target = this.serialByTarget.get(desktopId);
        if (target?.controlling === true) this.lease?.refresh(target.paneId);
        return accepted;
    }

    async candidate(desktopId: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null, connectionId?: string, deviceId?: string): Promise<{ accepted: boolean }> {
        const accepted = await this.require(desktopId, connectionId, deviceId).candidate(candidate, sdpMid, sdpMLineIndex);
        const target = this.serialByTarget.get(desktopId);
        if (target?.controlling === true) this.lease?.refresh(target.paneId);
        return accepted;
    }

    async poll(desktopId: string, cursor: number, connectionId?: string, deviceId?: string): Promise<{ cursor: number; events: DesktopEvent[] }> {
        const target = this.requiredTarget(desktopId, connectionId, deviceId);
        const engine = this.mirrors.engineFor(target.serial);
        if (engine === undefined) throw new EngineRefused('session', 'that desktop session is not open');
        for (const signal of engine.drainSignaling()) {
            if (signal.kind === 'offer') {
                this.append(desktopId, { kind: 'offer', generation: Number(signal.generation ?? 0), sdp: offeredAsBaseline(String(signal.sdp ?? '')) });
            } else if (signal.kind === 'candidate') {
                this.append(desktopId, {
                    kind: 'candidate',
                    generation: Number(signal.generation ?? 0),
                    candidate: String(signal.candidate ?? ''),
                    sdpMid: (signal.sdpMid as string | null) ?? null,
                    sdpMLineIndex: (signal.sdpMLineIndex as number | null) ?? null,
                });
            } else if (signal.kind === 'state') {
                this.append(desktopId, {
                    kind: 'state',
                    capture: String(signal.capture ?? 'unknown'),
                    transport: String(signal.transport ?? 'unknown'),
                    firstFrame: signal.firstFrame === true,
                });
            } else {
                this.append(desktopId, { kind: 'revoked', reason: String(signal.reason ?? 'the desktop session ended') });
            }
        }
        const backlog = this.backlog.get(desktopId) ?? { events: [], appended: 0 };
        const oldest = backlog.appended - backlog.events.length;
        const events = cursor >= oldest && cursor <= backlog.appended
            ? backlog.events.slice(cursor - oldest)
            : backlog.events.slice();
        const answer = { cursor: backlog.appended, events };
        if (target.controlling) this.lease?.refresh(target.paneId);
        if (events.some((event) => event.kind === 'revoked')) {
            this.serialByTarget.delete(desktopId);
            this.backlog.delete(desktopId);
            this.lease?.release(desktopId);
            await this.dropMirrorIfIdle(target.serial);
        }
        return answer;
    }

    async close(desktopId: string, connectionId?: string, deviceId?: string): Promise<{ closed: boolean }> {
        const target = this.serialByTarget.get(desktopId);
        if (target === undefined) return { closed: true };
        if (connectionId !== undefined && (deviceId === undefined || target.ownerDeviceId !== deviceId)) {
            throw new EngineRefused('session', 'that desktop session belongs to another device');
        }
        this.serialByTarget.delete(desktopId);
        this.backlog.delete(desktopId);
        this.lease?.release(desktopId);
        // The last viewer takes the mirror down: no watcher, no engine.
        await this.dropMirrorIfIdle(target.serial);
        return { closed: true };
    }

    /** A device owns its target sessions across reconnects; removal ends them. */
    setLinkDeviceConnected(deviceId: string, connected: boolean): void {
        const timer = this.disconnectTimers.get(deviceId);
        if (connected) {
            this.connectedLinkDevices.add(deviceId);
            if (timer !== undefined) clearTimeout(timer);
            this.disconnectTimers.delete(deviceId);
            return;
        }
        this.connectedLinkDevices.delete(deviceId);
        if (timer !== undefined || ![...this.serialByTarget.values()].some((target) => target.ownerDeviceId === deviceId)) return;
        const grace = setTimeout(() => {
            this.disconnectTimers.delete(deviceId);
            if (!this.connectedLinkDevices.has(deviceId)) {
                void this.revokeDevice(deviceId).catch(() => undefined);
            }
        }, 20_000);
        grace.unref?.();
        this.disconnectTimers.set(deviceId, grace);
    }

    async revokeDevice(deviceId: string): Promise<void> {
        this.setLinkDeviceConnected(deviceId, false);
        const timer = this.disconnectTimers.get(deviceId);
        if (timer !== undefined) clearTimeout(timer);
        this.disconnectTimers.delete(deviceId);
        for (const [desktopId, target] of [...this.serialByTarget]) {
            if (target.ownerDeviceId !== deviceId) continue;
            this.serialByTarget.delete(desktopId);
            this.backlog.delete(desktopId);
            await this.dropMirrorIfIdle(target.serial);
        }
        this.lease?.revokeDevice(deviceId);
    }

    async closeAll(): Promise<void> {
        for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
        this.disconnectTimers.clear();
        this.connectedLinkDevices.clear();
        this.serialByTarget.clear();
        this.backlog.clear();
        await this.mirrors.closeAll();
    }

    private readonly backlog = new Map<string, { events: DesktopEvent[]; appended: number }>();

    private append(desktopId: string, event: DesktopEvent): void {
        let entry = this.backlog.get(desktopId);
        if (entry === undefined) {
            entry = { events: [], appended: 0 };
            this.backlog.set(desktopId, entry);
        }
        entry.appended += 1;
        entry.events.push(event);
        if (entry.events.length > 32) entry.events.splice(0, entry.events.length - 32);
    }

    private async dropMirrorIfIdle(serial: string): Promise<void> {
        if ([...this.serialByTarget.values()].some((target) => target.serial === serial)) return;
        await this.mirrors.close(serial);
    }
}

// ---------------------------------------------------------------------------
// Watcher: discovery → adb → presence, at most one /proc scan per 2 s
// ---------------------------------------------------------------------------

export interface AndroidWatcherOptions {
    listSessions: () => Promise<Array<{ id: string; paneId?: string }>>;
    procRoot?: string;
    adb?: string;
    runAdb?: AdbRunner;
    mirrors?: AndroidMirrors;
    tracker?: DevicePresenceTracker;
    /** Engine binary for mirrors; unset means `DESKLINK_ENGINE` or the pin. */
    enginePath?: string;
    scanMs?: number;
    onDiagnostic?: (line: string) => void;
    lease?: PreviewLeaseTracker;
}

const WATCH_SCAN_MS = 2000;

/**
 * Owns discovery and presence for emulators. The host stamps session
 * lists from `previewFor` and pushes on `onChange`; targets open through
 * `targets`, which shares the watcher's serial map.
 */
export class AndroidEmulatorWatcher {
    readonly tracker: DevicePresenceTracker;
    readonly mirrors: AndroidMirrors;
    readonly targets: DevicePreviewTargets;
    private readonly options: AndroidWatcherOptions;
    private readonly serialByPane = new Map<string, string>();
    private timer: ReturnType<typeof setInterval> | undefined;

    private readonly runAdb: AdbRunner | undefined;

    constructor(options: AndroidWatcherOptions) {
        this.options = options;
        this.tracker = options.tracker ?? new DevicePresenceTracker();
        const adb = options.adb ?? findAdb();
        this.runAdb = options.runAdb ?? (adb === undefined ? undefined : adbRunner(adb));
        this.mirrors = options.mirrors ?? new AndroidMirrors({
            adb: adb ?? 'adb',
            ...(this.runAdb === undefined ? {} : { runAdb: this.runAdb }),
            ...(options.enginePath === undefined ? {} : { enginePath: options.enginePath }),
            ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
        });
        this.targets = new DevicePreviewTargets({
            mirrors: this.mirrors,
            listSessions: options.listSessions,
            previewFor: (paneId) => this.tracker.previewFor(paneId),
            // Only ever names emulators confirmed over adb for a live pane.
            serialForPane: (paneId) => this.serialByPane.get(paneId),
            ...(options.lease === undefined ? {} : { lease: options.lease }),
        });
    }

    start(): void {
        if (this.timer !== undefined) return;
        this.timer = setInterval(() => {
            void this.scan().catch(() => undefined);
        }, this.options.scanMs ?? WATCH_SCAN_MS);
        this.timer.unref?.();
        void this.scan().catch(() => undefined);
    }

    stop(): void {
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
        this.tracker.stop();
    }

    previewFor = (paneId: string): PreviewPresence | undefined => this.tracker.previewFor(paneId);

    onChange(listener: (paneId: string) => void): () => void {
        return this.tracker.onChange(listener);
    }

    private readonly titleCache = new Map<string, string | undefined>();

    /** One pass: scan, confirm over adb, update presence. Exposed for tests. */
    async scan(): Promise<void> {
        if (this.runAdb === undefined) return;
        const sessions = await this.options.listSessions().catch(() => []);
        const livePanes = new Set(sessions.flatMap((session) => session.paneId === undefined ? [] : [session.paneId]));
        const discovered = scanAndroidEmulators(this.options.procRoot ?? '/proc');
        const known = new Map<string, { serial: string; title: string | undefined }>();
        for (const emulator of discovered) {
            if (emulator.serial === undefined || !livePanes.has(emulator.paneId)) continue;
            if (this.serialByPane.get(emulator.paneId) !== emulator.serial) {
                if (!await this.confirm(emulator.serial)) continue;
                this.serialByPane.set(emulator.paneId, emulator.serial);
            }
            known.set(emulator.paneId, { serial: emulator.serial, title: this.titleCache.get(emulator.serial) });
        }
        for (const paneId of [...this.serialByPane.keys()]) {
            if (!known.has(paneId)) this.serialByPane.delete(paneId);
        }
        this.tracker.update(known);
    }

    /** True when the shared daemon reports this serial as an online device. */
    private async confirm(serial: string): Promise<boolean> {
        if (this.runAdb === undefined) return false;
        if (!await deviceOnline(this.runAdb, serial).catch(() => false)) return false;
        this.titleCache.set(serial, await avdTitle(this.runAdb, serial));
        return true;
    }
}

export function deviceCapabilities(): { available: boolean; input: boolean; clipboard: boolean; codec: string } {
    return { available: true, input: true, clipboard: false, codec: 'h264' };
}
