import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { connect as http2Connect, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EngineRefused } from '@desklink/host';
import type { DesktopPermission, PreviewPresence } from '@trymuxr/contract';

import type { PreviewLeaseTracker } from './previewLease.js';
import {
    DesklinkEncodedEngine,
    DevicePresenceTracker,
    DevicePreviewTargets,
    resolveVendoredResource,
    type DesklinkEncodedEngineOptions,
    type DeviceMirrors,
    type EncodedEngine,
    type EncodedEngineSession,
    type EncodedInput,
} from './androidEmulators.js';

/**
 * iOS Simulators via idb (Slice 1).
 *
 * A pane claims a booted simulator by UDID (`muxr preview claim`); the host
 * never offers a simulator nobody claimed. Video is idb's `sim-video` (Annex-B
 * H.264 from the simulator's own framebuffer) into the engine's encoded
 * source, and touch is one long-lived HID stream into `idb_companion`
 * (FBSimulatorHID), never one process per gesture. macOS only.
 */

// ---------------------------------------------------------------------------
// The vendored idb distribution
// ---------------------------------------------------------------------------

export const IDB_VERSION = '1.6.5';
const IDB_ARCHIVE = 'idb-companion.macos-arm64.tar.gz';

const run = (file: string, args: string[], timeoutMs = 15_000): Promise<string> => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
    });
});

let idbDir: Promise<string> | undefined;

/**
 * The extracted distribution, unpacked once per pinned hash into the user's
 * cache. `sim-video` alone would run, but `idb_companion` needs its bundles,
 * so the whole archive ships and unpacks as one.
 */
export function idbDistribution(cacheRoot = join(homedir(), 'Library', 'Caches', 'muxr')): Promise<string> {
    idbDir ??= (async () => {
        const archive = resolveVendoredResource(['idb', IDB_ARCHIVE], 'idb companion');
        const hash = readFileSync(`${archive}.sha256`, 'utf8').split(/\s+/)[0]!.slice(0, 12);
        const dir = join(cacheRoot, `idb-${IDB_VERSION}-${hash}`);
        if (existsSync(join(dir, 'sim-video')) && existsSync(join(dir, 'idb_companion'))) return dir;
        mkdirSync(cacheRoot, { recursive: true });
        const staging = mkdtempSync(join(cacheRoot, '.idb-'));
        try {
            await run('tar', ['-xzf', archive, '-C', staging], 60_000);
            // Another host may have won the race; its copy is as good as ours.
            if (!existsSync(dir)) renameSync(staging, dir);
        } finally {
            rmSync(staging, { recursive: true, force: true });
        }
        return dir;
    })().catch((error: unknown) => {
        idbDir = undefined;
        throw error;
    });
    return idbDir;
}

/** CoreSimulator's default set: where `simctl` boots what an agent creates. */
const DEVICE_SET = join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');

// ---------------------------------------------------------------------------
// Discovery: booted simulators, and the panes that claimed one
// ---------------------------------------------------------------------------

export interface BootedSimulator {
    udid: string;
    name: string;
    deviceTypeIdentifier?: string;
}

export async function bootedSimulators(): Promise<BootedSimulator[]> {
    const parsed = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])) as {
        devices?: Record<string, Array<{ udid?: string; name?: string; state?: string; deviceTypeIdentifier?: string }>>;
    };
    return Object.values(parsed.devices ?? {}).flat().flatMap((device) => {
        if (device.udid === undefined || device.state !== 'Booted') return [];
        const typed = device.deviceTypeIdentifier === undefined ? {} : { deviceTypeIdentifier: device.deviceTypeIdentifier };
        return [{ udid: device.udid, name: device.name ?? 'Simulator', ...typed }];
    });
}

/** `<claimsDir>/<paneId>` holds the UDID that pane claimed; unreadable claims are no claim. */
export function readSimulatorClaims(claimsDir: string): Map<string, string> {
    const claims = new Map<string, string>();
    let names: string[];
    try {
        names = readdirSync(claimsDir);
    } catch {
        return claims;
    }
    for (const paneId of names) {
        try {
            const udid = readFileSync(join(claimsDir, paneId), 'utf8').trim();
            if (/^[0-9A-Fa-f-]{36}$/.test(udid)) claims.set(paneId, udid.toUpperCase());
        } catch {
            // A claim being rewritten reads next scan.
        }
    }
    return claims;
}

const scaleCache = new Map<string, number>();

/** Pixels per point for a device type, from its profile; the HID speaks points. */
async function screenScale(deviceTypeIdentifier: string | undefined): Promise<number> {
    if (deviceTypeIdentifier === undefined) return 3;
    const cached = scaleCache.get(deviceTypeIdentifier);
    if (cached !== undefined) return cached;
    const types = JSON.parse(await run('xcrun', ['simctl', 'list', 'devicetypes', '-j'])) as {
        devicetypes?: Array<{ identifier?: string; bundlePath?: string }>;
    };
    const bundle = types.devicetypes?.find((type) => type.identifier === deviceTypeIdentifier)?.bundlePath;
    let scale = 3;
    if (bundle !== undefined) {
        const raw = await run('plutil', ['-extract', 'mainScreenScale', 'raw', join(bundle, 'Contents', 'Resources', 'profile.plist')]).catch(() => '');
        const parsed = Number(raw.trim());
        if (Number.isFinite(parsed) && parsed > 0) scale = parsed;
    }
    scaleCache.set(deviceTypeIdentifier, scale);
    return scale;
}

// ---------------------------------------------------------------------------
// Video: sim-video's byte stream → one access unit per feed
// ---------------------------------------------------------------------------

/**
 * Splits Annex-B into access units: a unit ends where the next begins (a
 * parameter set, an AUD or SEI after a slice, or a slice whose first
 * macroblock is 0). `sim-video` writes one frame per write, so the last unit
 * also goes out once the pipe has been quiet briefly.
 * ponytail: idle flush (AU_IDLE_MS) instead of parsing slice headers for
 * frame_num; parse them if a stream ever pauses mid-frame for that long.
 */
const AU_IDLE_MS = 4;

export class AnnexBAccessUnits {
    private pending: Buffer = Buffer.alloc(0);
    private sawSlice = false;
    private unitStart = 0;
    private scanFrom = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly emit: (keyframe: boolean, unit: Buffer) => void) {}

    push(chunk: Buffer): void {
        this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
        const data = this.pending;
        // The scan resumes where the last one stopped short, so a start code
        // split across two chunks is still seen.
        let index = this.scanFrom;
        for (; index + 4 < data.length; index += 1) {
            if (data[index] !== 0 || data[index + 1] !== 0) continue;
            const long = data[index + 2] === 0 && data[index + 3] === 1;
            if (!long && data[index + 2] !== 1) continue;
            const header = index + (long ? 4 : 3);
            if (header + 1 >= data.length) break;
            const type = data[header]! & 0x1f;
            const slice = type === 1 || type === 5;
            const firstSliceOfFrame = slice && (data[header + 1]! & 0x80) !== 0;
            if (this.sawSlice && index > this.unitStart && (firstSliceOfFrame || type === 6 || type === 7 || type === 8 || type === 9)) {
                this.flushUnit(data.subarray(this.unitStart, index));
                this.unitStart = index;
                this.sawSlice = false;
            }
            if (slice) this.sawSlice = true;
            index = header;
        }
        this.scanFrom = index;
        if (this.unitStart > 0) {
            this.pending = data.subarray(this.unitStart);
            this.scanFrom -= this.unitStart;
            this.unitStart = 0;
        }
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flushTail(), AU_IDLE_MS);
    }

    flushTail(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.sawSlice || this.pending.length === 0) return;
        this.flushUnit(this.pending);
        this.pending = Buffer.alloc(0);
        this.scanFrom = 0;
        this.sawSlice = false;
    }

    stop(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private flushUnit(unit: Buffer): void {
        let keyframe = false;
        for (let index = 0; index + 3 < unit.length; index += 1) {
            if (unit[index] === 0 && unit[index + 1] === 0 && unit[index + 2] === 1 && (unit[index + 3]! & 0x1f) === 5) {
                keyframe = true;
                break;
            }
        }
        // Copied: the next push may reuse the bytes behind this view.
        this.emit(keyframe, Buffer.from(unit));
    }
}

/** Width and height in pixels from the first SPS, or undefined if it is not there yet. */
export function spsSize(stream: Buffer): { width: number; height: number } | undefined {
    for (let index = 0; index + 4 < stream.length; index += 1) {
        if (stream[index] !== 0 || stream[index + 1] !== 0 || stream[index + 2] !== 1 || (stream[index + 3]! & 0x1f) !== 7) continue;
        // Emulation prevention bytes out, then the fields up to the cropping window.
        const raw: number[] = [];
        for (let at = index + 4; at < stream.length && raw.length < 64; at += 1) {
            if (raw.length >= 2 && raw[raw.length - 1] === 0 && raw[raw.length - 2] === 0 && stream[at] === 3) continue;
            raw.push(stream[at]!);
        }
        let bit = 0;
        const u = (n: number): number => {
            let value = 0;
            for (let i = 0; i < n; i += 1, bit += 1) {
                const byte = raw[bit >> 3];
                if (byte === undefined) throw new Error('truncated SPS');
                value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
            }
            return value;
        };
        const ue = (): number => {
            let zeros = 0;
            while (u(1) === 0 && zeros < 32) zeros += 1;
            return (2 ** zeros) - 1 + u(zeros);
        };
        const se = (): number => {
            const value = ue();
            return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
        };
        try {
            const profile = u(8);
            u(16);
            ue();
            let chroma = 1;
            if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
                chroma = ue();
                if (chroma === 3) u(1);
                ue();
                ue();
                u(1);
                if (u(1) === 1) {
                    for (let list = 0; list < (chroma === 3 ? 12 : 8); list += 1) {
                        if (u(1) === 0) continue;
                        let last = 8;
                        let next = 8;
                        for (let j = 0; j < (list < 6 ? 16 : 64); j += 1) {
                            if (next !== 0) next = (last + se() + 256) % 256;
                            last = next === 0 ? last : next;
                        }
                    }
                }
            }
            ue();
            const pocType = ue();
            if (pocType === 0) ue();
            else if (pocType === 1) {
                u(1);
                se();
                se();
                const cycle = ue();
                for (let i = 0; i < cycle; i += 1) se();
            }
            ue();
            u(1);
            const widthMbs = ue() + 1;
            const heightUnits = ue() + 1;
            const frameMbsOnly = u(1);
            if (frameMbsOnly === 0) u(1);
            u(1);
            let crop = [0, 0, 0, 0];
            if (u(1) === 1) crop = [ue(), ue(), ue(), ue()];
            const cropX = chroma === 0 || chroma === 3 ? 1 : 2;
            const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
            return {
                width: widthMbs * 16 - (crop[0]! + crop[1]!) * cropX,
                height: heightUnits * 16 * (2 - frameMbsOnly) - (crop[2]! + crop[3]!) * cropY,
            };
        } catch {
            return undefined;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Input: one long-lived HID stream into idb_companion
// ---------------------------------------------------------------------------

// Hand-encoded idb.proto (v1.6.5): HIDEvent{press=1}, HIDPress{action=1,
// direction=2 (DOWN=0, UP=1)}, HIDPressAction{touch=1, button=2},
// HIDTouch{point=1}, Point{x=1, y=2 doubles}, HIDButton{button=1, HOME=1}.
const varint = (value: number): Buffer => {
    const out: number[] = [];
    while (value > 127) {
        out.push((value & 127) | 128);
        value = Math.floor(value / 128);
    }
    out.push(value);
    return Buffer.from(out);
};
const field = (number: number, body: Buffer): Buffer => Buffer.concat([varint((number << 3) | 2), varint(body.length), body]);
const double = (number: number, value: number): Buffer => {
    const out = Buffer.alloc(9);
    out[0] = (number << 3) | 1;
    out.writeDoubleLE(value, 1);
    return out;
};
const enumField = (number: number, value: number): Buffer => value === 0 ? Buffer.alloc(0) : Buffer.concat([varint(number << 3), varint(value)]);
const grpcFrame = (message: Buffer): Buffer => {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(message.length, 1);
    return Buffer.concat([header, message]);
};

export function hidTouch(down: boolean, x: number, y: number): Buffer {
    const point = Buffer.concat([double(1, x), double(2, y)]);
    return grpcFrame(field(1, Buffer.concat([field(1, field(1, field(1, point))), enumField(2, down ? 0 : 1)])));
}

export function hidHomeButton(down: boolean): Buffer {
    return grpcFrame(field(1, Buffer.concat([field(1, field(2, enumField(1, 1))), enumField(2, down ? 0 : 1)])));
}

const COMPANION_START_TIMEOUT_MS = 15_000;

/** One companion per mirrored simulator, and the HID request it keeps open. */
class CompanionHid {
    private session: ClientHttp2Session | undefined;
    private stream: ClientHttp2Stream | undefined;

    constructor(
        private readonly companion: ChildProcess,
        private readonly socket: string,
        private readonly onDiagnostic?: (line: string) => void,
    ) {}

    static async start(dir: string, udid: string, workDir: string, onDiagnostic?: (line: string) => void, onSpawn?: (child: ChildProcess) => void): Promise<CompanionHid> {
        const socket = join(workDir, 'hid.sock');
        const companion = spawn(join(dir, 'idb_companion'), [
            '--udid', udid, '--grpc-domain-sock', socket, '--device-set-path', DEVICE_SET,
            // Simulators only: without it the companion opens a session to every attached device.
            '--only', 'simulator',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        onSpawn?.(companion);
        companion.stderr?.on('data', (chunk: Buffer) => onDiagnostic?.(`idb companion: ${chunk.toString().trim().slice(0, 200)}`));
        const deadline = Date.now() + COMPANION_START_TIMEOUT_MS;
        while (!existsSync(socket)) {
            if (companion.exitCode !== null || Date.now() > deadline) {
                companion.kill('SIGKILL');
                throw new EngineRefused('desktop-unavailable', 'the simulator input service did not start');
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return new CompanionHid(companion, socket, onDiagnostic);
    }

    /** Writes one event, reopening the stream if the companion ended the last one. */
    send(frame: Buffer): void {
        if (this.stream === undefined || this.stream.closed || this.stream.destroyed) {
            if (this.session === undefined || this.session.closed || this.session.destroyed) {
                this.session = http2Connect('http://localhost', { createConnection: () => netConnect(this.socket) });
                this.session.on('error', (error) => this.onDiagnostic?.(`idb hid: ${error.message}`));
            }
            this.stream = this.session.request({
                ':method': 'POST',
                ':path': '/idb.CompanionService/hid',
                'content-type': 'application/grpc',
                te: 'trailers',
            });
            this.stream.on('error', (error) => this.onDiagnostic?.(`idb hid stream: ${error.message}`));
            this.stream.resume();
        }
        this.stream.write(frame);
    }

    close(): void {
        this.stream?.end();
        this.session?.close();
        if (this.companion.exitCode === null) this.companion.kill('SIGTERM');
    }
}

// ---------------------------------------------------------------------------
// Mirrors: sim-video + companion per watched simulator
// ---------------------------------------------------------------------------

export interface IosMirrorOptions {
    makeEngine?: (options: DesklinkEncodedEngineOptions) => EncodedEngine;
    enginePath?: string;
    onDiagnostic?: (line: string) => void;
    /** Device type per UDID, for the point scale; the watcher knows it. */
    deviceTypeFor?: (udid: string) => string | undefined;
}

const MAX_INFLIGHT_FEEDS = 3;
const MIRROR_BIT_RATE = 2_000_000;
/** An IDR this often: a viewer that joins or loses a frame recovers within it. */
const KEY_FRAME_EVERY = 5;
/**
 * Half the panel: a 1206x2622 picture is past what many phone decoders open
 * (the emulator's among them) and twice what a phone screen shows.
 */
const VIDEO_SCALE = 0.5;
const VIDEO_START_TIMEOUT_MS = 15_000;
const CLOSE_EXIT_WAIT_MS = 2_000;

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
        }, timeoutMs);
        const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
        };
        child.once('exit', onExit);
    });
};

interface LiveSimulator {
    engine: EncodedEngine;
    session: EncodedEngineSession;
    width: number;
    height: number;
    scale: number;
    video: ChildProcess;
    hid: CompanionHid;
    splitter: AnnexBAccessUnits;
    workDir: string;
    inflight: number;
    fingerDown: boolean;
    lastX: number;
    lastY: number;
    closed: boolean;
}

interface SpawnedHelperEntry {
    children: Set<ChildProcess>;
    closed: boolean;
    phase: 'opening' | 'settled';
}

class SpawnedHelpers {
    private readonly entries = new Map<string, SpawnedHelperEntry>();

    private entryFor(udid: string): SpawnedHelperEntry {
        let entry = this.entries.get(udid);
        if (entry === undefined) {
            entry = { children: new Set(), closed: false, phase: 'opening' };
            this.entries.set(udid, entry);
        }
        return entry;
    }

    reopen(udid: string): void {
        const entry = this.entryFor(udid);
        entry.closed = false;
        entry.phase = 'opening';
    }

    register(udid: string, child: ChildProcess): void {
        const entry = this.entryFor(udid);
        entry.children.add(child);
        child.once('exit', () => {
            this.entries.get(udid)?.children.delete(child);
        });
        if (entry.closed && child.pid !== undefined) {
            try {
                process.kill(child.pid, 'SIGTERM');
            } catch {
            }
        }
    }

    settle(udid: string): void {
        const entry = this.entries.get(udid);
        if (entry !== undefined) entry.phase = 'settled';
    }

    isClosed(udid: string): boolean {
        return this.entries.get(udid)?.closed === true;
    }

    keys(): string[] {
        return [...this.entries.keys()];
    }

    async close(udid: string, onStraggler: (pid: number | undefined, phase: 'opening' | 'settled') => void): Promise<void> {
        const entry = this.entryFor(udid);
        entry.closed = true;
        const tracked = [...entry.children];
        for (const child of tracked) {
            const pid = child.pid;
            if (pid === undefined || child.exitCode !== null) continue;
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
            }
        }
        const exited = await Promise.all(tracked.map((child) => waitForExit(child, CLOSE_EXIT_WAIT_MS)));
        tracked.forEach((child, index) => {
            if (exited[index] !== true) onStraggler(child.pid, entry.phase);
        });
    }
}

export class IosMirrors implements DeviceMirrors {
    private readonly options: IosMirrorOptions;
    private readonly mirrors = new Map<string, LiveSimulator>();
    private readonly opening = new Map<string, Promise<{ session: EncodedEngineSession; width: number; height: number }>>();
    private readonly helpers = new SpawnedHelpers();

    constructor(options: IosMirrorOptions = {}) {
        this.options = options;
    }

    async open(
        udid: string,
        request: { permissions: DesktopPermission[]; maxFps?: number; loopbackTcp?: boolean },
    ): Promise<{ session: EncodedEngineSession; width: number; height: number }> {
        const existing = this.mirrors.get(udid);
        if (existing !== undefined && !existing.closed) return { session: existing.session, width: existing.width, height: existing.height };
        const inflight = this.opening.get(udid);
        if (inflight !== undefined) return inflight;
        this.helpers.reopen(udid);
        const opening = this.start(udid, request).finally(() => {
            if (this.opening.get(udid) === opening) this.opening.delete(udid);
        });
        this.opening.set(udid, opening);
        return opening;
    }

    private async start(
        udid: string,
        request: { permissions: DesktopPermission[]; maxFps?: number; loopbackTcp?: boolean },
    ): Promise<{ session: EncodedEngineSession; width: number; height: number }> {
        const dir = await idbDistribution().catch((error: unknown) => {
            throw new EngineRefused('desktop-unavailable', error instanceof Error ? error.message : 'the idb companion is not installed');
        });
        // Stream pixels per simulator point.
        const scale = VIDEO_SCALE * await screenScale(this.options.deviceTypeFor?.(udid)).catch(() => 3);
        if (this.helpers.isClosed(udid)) throw new EngineRefused('desktop-unavailable', 'the preview closed during open');
        const workDir = mkdtempSync(join(homedir(), 'Library', 'Caches', 'muxr', '.sim-'));
        const video = spawn(join(dir, 'sim-video'), [
            'stream', '--set', DEVICE_SET, '--udid', udid,
            '--encoding', 'h264', '--transport', 'annex-b', '--scale', String(VIDEO_SCALE),
            '--avg-bitrate', String(MIRROR_BIT_RATE), '--key-frame-rate', String(KEY_FRAME_EVERY), '-',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        video.stderr?.on('data', (chunk: Buffer) => this.options.onDiagnostic?.(`sim-video: ${chunk.toString().trim().slice(0, 200)}`));
        video.stdin?.on('error', () => undefined);
        this.helpers.register(udid, video);
        let hid: CompanionHid | undefined;
        const fail = (message: string): never => {
            this.options.onDiagnostic?.(`open failed: ${message}`);
            video.kill('SIGKILL');
            hid?.close();
            rmSync(workDir, { recursive: true, force: true });
            throw new EngineRefused('desktop-unavailable', message);
        };
        // Units buffer until the engine exists; the first SPS sizes the open.
        const opening: Array<{ keyframe: boolean; unit: Buffer }> = [];
        let target: ((keyframe: boolean, unit: Buffer) => void) | null = null;
        const splitter = new AnnexBAccessUnits((keyframe, unit) => {
            if (target !== null) target(keyframe, unit);
            else if (opening.length < 90 || keyframe) opening.push({ keyframe, unit });
        });
        let size: { width: number; height: number } | undefined;
        let headerBytes = Buffer.alloc(0);
        video.stdout?.on('data', (chunk: Buffer) => {
            if (size === undefined) {
                if (headerBytes.length < 1024 * 1024) headerBytes = Buffer.concat([headerBytes, chunk]);
                size = spsSize(headerBytes);
            }
            splitter.push(chunk);
        });
        const deadline = Date.now() + VIDEO_START_TIMEOUT_MS;
        while (size === undefined && video.exitCode === null && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (this.helpers.isClosed(udid)) fail('the preview closed during open');
        if (size === undefined) fail('the simulator sent no video');
        try {
            hid = await CompanionHid.start(dir, udid, workDir, this.options.onDiagnostic, (child) => this.helpers.register(udid, child));
        } catch (error) {
            fail(error instanceof Error ? error.message : 'the simulator input service did not start');
        }
        const makeEngine = this.options.makeEngine ?? ((engineOptions) => new DesklinkEncodedEngine(engineOptions));
        const engine = makeEngine({
            ...(this.options.enginePath === undefined ? {} : { enginePath: this.options.enginePath }),
            ...(this.options.onDiagnostic === undefined ? {} : { onDiagnostic: this.options.onDiagnostic }),
        });
        const { width, height } = size!;
        let session: EncodedEngineSession;
        try {
            session = await engine.open(width, height, request.permissions, {
                ...(request.maxFps === undefined ? {} : { maxFps: request.maxFps }),
                ...(request.loopbackTcp === true ? { loopbackTcp: true } : {}),
            });
        } catch (error) {
            fail(error instanceof Error ? error.message : 'the live view did not start');
        }
        if (this.helpers.isClosed(udid)) {
            await engine.close().catch(() => undefined);
            await engine.stop().catch(() => undefined);
            fail('the preview closed during open');
        }
        const mirror: LiveSimulator = {
            engine,
            session: session!,
            width,
            height,
            scale,
            video,
            hid: hid!,
            splitter,
            workDir,
            inflight: 0,
            fingerDown: false,
            lastX: width / 2,
            lastY: height / 2,
            closed: false,
        };
        this.mirrors.set(udid, mirror);
        this.helpers.settle(udid);
        engine.onLive((event) => {
            if (mirror.closed) return;
            if (event.kind === 'keyframeRequest') {
                if (video.exitCode === null) video.stdin?.write('{"method":"force_keyframe"}\n');
                return;
            }
            this.applyInput(mirror, event.input);
        });
        for (const unit of opening.splice(0)) {
            if (mirror.closed) break;
            await engine.feed(unit.keyframe, unit.unit).catch(() => undefined);
        }
        target = (keyframe, unit) => {
            if (mirror.inflight >= MAX_INFLIGHT_FEEDS) return;
            mirror.inflight += 1;
            engine.feed(keyframe, unit).catch(() => undefined).finally(() => {
                mirror.inflight -= 1;
            });
        };
        video.once('exit', () => void this.close(udid).catch(() => undefined));
        return { session: session!, width, height };
    }

    /** Engine pixels → simulator points: touch down/move/up and the Home button. */
    applyInput(mirror: LiveSimulator, input: EncodedInput): void {
        if (mirror.closed) return;
        const touch = (down: boolean): void => {
            mirror.hid.send(hidTouch(down, mirror.lastX / mirror.scale, mirror.lastY / mirror.scale));
        };
        switch (input.kind) {
            case 'pointer': {
                mirror.lastX = Math.max(0, Math.min(mirror.width - 1, input.x));
                mirror.lastY = Math.max(0, Math.min(mirror.height - 1, input.y));
                if (input.phase === 'down') {
                    mirror.fingerDown = true;
                    touch(true);
                } else if (input.phase === 'up' || input.phase === 'cancel') {
                    if (!mirror.fingerDown) return;
                    mirror.fingerDown = false;
                    touch(false);
                } else if (mirror.fingerDown) {
                    // The HID has no move: a held finger is another down at the new point.
                    touch(true);
                }
                return;
            }
            case 'release_all': {
                if (!mirror.fingerDown) return;
                mirror.fingerDown = false;
                touch(false);
                return;
            }
            case 'key': {
                // The toolbar's Home (Ctrl+H, as on Android); other keys wait for a keyboard slice.
                const control = (input.modifiers ?? []).some((modifier) => modifier.toLowerCase() === 'control');
                if (control && input.character === 'h') mirror.hid.send(hidHomeButton(input.down));
                return;
            }
            default:
                return;
        }
    }

    engineFor(udid: string): EncodedEngine | undefined {
        const mirror = this.mirrors.get(udid);
        return mirror === undefined || mirror.closed ? undefined : mirror.engine;
    }

    async close(udid: string): Promise<void> {
        const inflight = this.opening.get(udid);
        if (inflight !== undefined) void inflight.catch(() => undefined);
        const mirror = this.mirrors.get(udid);
        if (mirror !== undefined) {
            this.mirrors.delete(udid);
            mirror.closed = true;
        }
        await this.helpers.close(udid, (pid, phase) => this.options.onDiagnostic?.(`close: helper ${pid ?? '?'} did not exit (${phase})`));
        if (mirror === undefined) return;
        mirror.splitter.stop();
        mirror.hid.close();
        rmSync(mirror.workDir, { recursive: true, force: true });
        await mirror.engine.close().catch(() => undefined);
        await mirror.engine.stop().catch(() => undefined);
    }

    async closeAll(): Promise<void> {
        await Promise.all(this.helpers.keys().map((udid) => this.close(udid)));
    }
}

// ---------------------------------------------------------------------------
// Watcher: claims ∩ booted → presence, at most one simctl call per 2 s
// ---------------------------------------------------------------------------

export interface IosWatcherOptions {
    listSessions: () => Promise<Array<{ id: string; paneId?: string }>>;
    /** `$MUXR_HOME/preview/simulators`: one file per claiming pane. */
    claimsDir: string;
    enginePath?: string;
    scanMs?: number;
    onDiagnostic?: (line: string) => void;
    lease?: PreviewLeaseTracker;
}

/**
 * Owns presence for claimed simulators. Only a pane's explicit claim ever
 * announces one, and only while that simulator is booted and the pane lives.
 */
export class IosSimulatorWatcher {
    readonly tracker = new DevicePresenceTracker({ kind: 'ios' });
    readonly mirrors: IosMirrors;
    readonly targets: DevicePreviewTargets;
    private readonly options: IosWatcherOptions;
    private readonly udidByPane = new Map<string, string>();
    private readonly deviceTypes = new Map<string, string | undefined>();
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(options: IosWatcherOptions) {
        this.options = options;
        this.mirrors = new IosMirrors({
            deviceTypeFor: (udid) => this.deviceTypes.get(udid),
            ...(options.enginePath === undefined ? {} : { enginePath: options.enginePath }),
            ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
        });
        this.targets = new DevicePreviewTargets({
            kind: 'ios',
            mirrors: this.mirrors,
            listSessions: options.listSessions,
            previewFor: (paneId) => this.tracker.previewFor(paneId),
            serialForPane: (paneId) => this.udidByPane.get(paneId),
            ...(options.lease === undefined ? {} : { lease: options.lease }),
        });
    }

    start(): void {
        if (process.platform !== 'darwin' || this.timer !== undefined) return;
        this.timer = setInterval(() => {
            void this.scan().catch(() => undefined);
        }, this.options.scanMs ?? 2000);
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

    async scan(): Promise<void> {
        const claims = readSimulatorClaims(this.options.claimsDir);
        const known = new Map<string, { serial: string; title: string | undefined }>();
        if (claims.size > 0) {
            const sessions = await this.options.listSessions().catch(() => []);
            const livePanes = new Set(sessions.flatMap((session) => session.paneId === undefined ? [] : [session.paneId]));
            const booted = new Map((await bootedSimulators().catch(() => [])).map((device) => [device.udid, device]));
            for (const [paneId, udid] of claims) {
                const device = booted.get(udid);
                if (device === undefined || !livePanes.has(paneId)) continue;
                this.deviceTypes.set(udid, device.deviceTypeIdentifier);
                known.set(paneId, { serial: udid, title: device.name });
            }
        }
        this.udidByPane.clear();
        for (const [paneId, { serial }] of known) this.udidByPane.set(paneId, serial);
        this.tracker.update(known);
    }
}
