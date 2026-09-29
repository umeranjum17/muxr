import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import { AndroidEmulatorWatcher, AndroidPreviewTargets, AndroidPresenceTracker, adbRunner } from './androidEmulators.js';
import { PreviewLeaseTracker, type PreviewLeaseSnapshot } from './previewLease.js';

/**
 * The headless-emulator road, pane to pixels to control bytes.
 *
 * A fixture /proc holds a `-no-window` emulator whose environ is wiped (as
 * the real one's is) under a pane shell, a headed emulator that must stay
 * invisible, and a port-less one found through its console socket. A stub adb
 * asserts the exact shapes the host calls it with, a stub engine speaks the
 * local protocol, and a fake device serves scrcpy bytes over real loopback
 * sockets. What this catches is the part that would silently show the wrong
 * thing: attribution to the pane, the AVD title, the Annex-B feed, and the
 * touch and device-key bytes the emulator receives. Break any of those and
 * this goes red.
 */

const ADB_STUB = `#!${process.execPath}
const net = require('node:net');
const { spawn } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const log = process.env.MUXR_TEST_ADB_LOG;
const backend = Number(process.env.MUXR_TEST_DEVICE_PORT);
const relayMapFile = process.env.MUXR_TEST_RELAY_FILE;
const record = (extra) => appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), ...extra }) + '\\n');
const relayCode = 'const net=require("node:net");' +
  'const [port,target]=process.argv.slice(1).map(Number);' +
  'net.createServer((client)=>{' +
  'const device=net.connect(target,"127.0.0.1");' +
  'client.on("error",()=>device.destroy());device.on("error",()=>client.destroy());' +
  'client.pipe(device).pipe(client);}).listen(port,"127.0.0.1");' +
  'setInterval(()=>{},1000);';
const relayMap = () => { try { return JSON.parse(readFileSync(relayMapFile, 'utf8')); } catch { return {}; } };
const args = process.argv.slice(2);
if (args[0] === 'devices' && args.length === 1) {
    record({});
    process.stdout.write('List of devices attached\\nemulator-5572\\tdevice\\n');
    process.exit(0);
}
if (args[0] === '-s' && args[2] === 'emu') {
    record({});
    process.stdout.write('Medium_Phone\\nOK\\n');
    process.exit(0);
}
if (args[0] === '-s' && args[2] === 'push') {
    record({});
    process.exit(0);
}
if (args[0] === '-s' && args[2] === 'forward' && args[3] !== '--remove') {
    const port = Number(args[3].split(':')[1]);
    const child = spawn(process.execPath, ['-e', relayCode, String(port), String(backend)], { detached: true, stdio: 'ignore' });
    child.unref();
    const map = relayMap();
    map[port] = child.pid;
    writeFileSync(relayMapFile, JSON.stringify(map));
    record({ relay: port });
    process.exit(0);
}
if (args[0] === '-s' && args[2] === 'forward' && args[3] === '--remove') {
    const port = Number(args[4].split(':')[1]);
    record({});
    try {
        process.kill(relayMap()[port], 'SIGTERM');
    } catch {}
    process.exit(0);
}
if (args[0] === '-s' && args[2] === 'shell') {
    record({});
    setInterval(() => {}, 1000);
    return;
}
record({});
process.stderr.write('unexpected adb call\\n');
process.exit(1);
`;

const ENGINE_STUB = `#!${process.execPath}
if (process.argv[2] === 'version') {
    process.stdout.write('stub/0\\n');
    process.exit(0);
}
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const log = process.env.MUXR_TEST_ENGINE_LOG;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const session = { id: 'eng-1', generation: 1 };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    appendFileSync(log, JSON.stringify(request) + '\\n');
    if (request.method === 'hello') return out({ id: request.id, result: { ok: true } });
    if (request.method === 'session.open') {
        const source = request.params.source;
        if (source.kind !== 'encoded' || source.codec !== 'h264' || source.width !== 540 || source.height !== 1200) {
            return out({ id: request.id, error: { code: 'source', message: 'wrong encoded open' } });
        }
        setTimeout(() => {
            out({ event: 'session.keyframeRequest', params: { sessionId: session.id, generation: 1 } });
            out({ event: 'session.input', params: { sessionId: session.id, input: { kind: 'pointer', phase: 'down', x: 100, y: 200 } } });
            out({ event: 'session.input', params: { sessionId: session.id, input: { kind: 'pointer', phase: 'up', x: 100, y: 200 } } });
            out({ event: 'session.input', params: { sessionId: session.id, input: { kind: 'key', name: 'Backspace', down: true, modifiers: ['Control'] } } });
            out({ event: 'session.input', params: { sessionId: session.id, input: { kind: 'key', name: 'Backspace', down: false, modifiers: ['Control'] } } });
            out({ event: 'session.input', params: { sessionId: session.id, input: { kind: 'text', text: 'hi' } } });
        }, 30);
        setTimeout(() => {
            out({ event: 'session.description', params: { sessionId: session.id, generation: 1, description: { type: 'offer', sdp: 'v=0 offer' } } });
            out({ event: 'session.state', params: { sessionId: session.id, capture: 'encoded', transport: 'webrtc', firstFrame: true } });
        }, 60);
        return setTimeout(() => out({ id: request.id, result: {
            sessionId: session.id, generation: 1,
            source: { kind: 'encoded', width: 540, height: 1200, origin: { x: 0, y: 0 } },
            geometry: { source: { width: 540, height: 1200 }, encoded: { width: 540, height: 1200 }, origin: { x: 0, y: 0 } },
        } }), 1);
    }
    if (request.method === 'session.feed') return out({ id: request.id, result: { accepted: true } });
    if (request.method === 'session.description') return out({ id: request.id, result: { accepted: true } });
    if (request.method === 'session.candidate') return out({ id: request.id, result: { accepted: true } });
    if (request.method === 'session.close') return out({ id: request.id, result: { closed: true } });
    return out({ id: request.id, error: { code: 'operation', message: 'unexpected' } });
});
`;

function stub(directory: string, name: string, source: string): string {
    const path = join(directory, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
    return path;
}

function procPid(root: string, pid: string, files: Record<string, string>): void {
    mkdirSync(join(root, pid), { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, pid, name), content);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label: string, ready: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await ready()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(25);
    }
}

describe('a headless emulator in an agent pane', () => {
    it('announces the AVD, mirrors it through the encoded source, and drives it', async () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-android-'));
        const backendPort = await new Promise<number>((resolve) => {
            const probe = createServer();
            probe.listen(0, '127.0.0.1', () => {
                const address = probe.address();
                probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
            });
        });
        const adb = stub(root, 'adb', ADB_STUB);
        const engine = stub(root, 'engine', ENGINE_STUB);
        const engineLog = join(root, 'engine.log');
        writeFileSync(engineLog, '');
        const adbLog = join(root, 'adb.log');
        writeFileSync(adbLog, '');
        const relayFile = join(root, 'relay.map');
        writeFileSync(relayFile, JSON.stringify({}));
        process.env.MUXR_TEST_DEVICE_PORT = String(backendPort);
        process.env.MUXR_TEST_RELAY_FILE = relayFile;
        process.env.MUXR_TEST_ADB_LOG = adbLog;
        process.env.MUXR_TEST_ENGINE_LOG = engineLog;
        try {
            // The pane shell owns the wiped emulator processes by ancestry.
            const proc = join(root, 'proc');
            procPid(proc, '1', { comm: 'init\n', cmdline: 'init\0', environ: '', stat: '1 (init) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n' });
            procPid(proc, '4190', {
                comm: 'bash\n',
                cmdline: 'bash\0',
                environ: 'HERDR_PANE_ID=w9:p1\0DISPLAY=:141\0',
                stat: '4190 (bash) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
            });
            procPid(proc, '4200', {
                comm: 'qemu-system-x86_64\n',
                cmdline: 'qemu-system-x86_64\x00-no-window\x00-port\x005572\x00',
                environ: '',
                stat: '4200 (qemu-system-x86_64) S 4190 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
            });
            // Headed: the keeper's business, invisible here.
            procPid(proc, '4300', {
                comm: 'qemu-system-x86_64\n',
                cmdline: 'qemu-system-x86_64\x00-window\x00-port\x005580\x00',
                environ: '',
                stat: '4300 (qemu-system-x86_64) S 4190 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
            });
            // No -port: found through its console listen socket instead.
            mkdirSync(join(proc, '4400', 'fd'), { recursive: true });
            procPid(proc, '4400', {
                comm: 'qemu-system-x86_64\n',
                cmdline: 'qemu-system-x86_64\0-no-window\0',
                environ: '',
                stat: '4400 (qemu-system-x86_64) S 4190 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
            });
            symlinkSync('socket:[99991]', join(proc, '4400', 'fd', '7'));
            mkdirSync(join(proc, 'net'), { recursive: true });
            writeFileSync(join(proc, 'net', 'tcp'),
                '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
                '   0: 00000000:15C6 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 99991 1 0000000000000000 100 0 0 10 0\n');

            // The fake device: a scrcpy server that serves fixed bytes.
            const sps = Buffer.from([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x78]);
            const idr = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x33, 0xff, 0x01, 0x02, 0x03, 0x04]);
            const received: Buffer[] = [];
            const sockets: Socket[] = [];
            const backend: Server = createServer((socket) => {
                sockets.push(socket);
                socket.on('error', () => undefined);
                const first = sockets.length;
                if (first === 1) {
                    const header = Buffer.alloc(1 + 64 + 4);
                    header.writeUInt32BE(0x68323634, 1 + 64);
                    socket.write(header);
                    const session = Buffer.alloc(12);
                    session.writeUInt32BE(0x80000000, 0);
                    session.writeUInt32BE(540, 4);
                    session.writeUInt32BE(1200, 8);
                    socket.write(session);
                    const config = Buffer.alloc(12);
                    config.writeBigUInt64BE(1n << 62n, 0);
                    config.writeUInt32BE(sps.length, 8);
                    socket.write(Buffer.concat([config, sps]));
                    const frame = Buffer.alloc(12);
                    frame.writeBigUInt64BE((1n << 61n) | 1000n, 0);
                    frame.writeUInt32BE(idr.length, 8);
                    socket.write(Buffer.concat([frame, idr]));
                } else {
                    socket.write(Buffer.from([0x00]));
                    socket.on('data', (chunk: Buffer) => received.push(chunk));
                }
            });
            await new Promise<void>((resolve) => backend.listen(backendPort, '127.0.0.1', resolve));

            const watcher = new AndroidEmulatorWatcher({
                listSessions: async () => [{ id: 'sess-1', paneId: 'w9:p1' }],
                procRoot: proc,
                adb: adb,
                runAdb: adbRunner(adb),
                tracker: new AndroidPresenceTracker({ announceAfterMs: 10, withdrawAfterMs: 10 }),
                enginePath: engine,
                scanMs: 60_000,
            });
            try {
                const seen: string[] = [];
                watcher.onChange((paneId) => seen.push(paneId));
                await watcher.scan();
                await waitFor('presence', () => watcher.previewFor('w9:p1') !== undefined);
                // The AVD name, readable, never a serial or a pid.
                expect(watcher.previewFor('w9:p1')).toMatchObject({ kind: 'android', title: 'Medium Phone' });
                expect(seen).toContain('w9:p1');

                // An unknown session is refused, never fallen back to a desktop.
                await expect(watcher.targets.resolveTarget('nope')).rejects.toMatchObject({ code: 'permission-denied' });
                const target = await watcher.targets.resolveTarget('sess-1');
                expect(target).toMatchObject({ paneId: 'w9:p1', serial: 'emulator-5572' });

                // Watching starts the mirror: the jar is pushed, the server
                // spawned, and the stream opens an encoded session.
                const opened = await watcher.targets.openTarget('sess-1', { permissions: ['view'] }, { deviceId: 'phone-1' });
                expect(opened.desktopId).toMatch(/^av/);
                expect(opened.geometry.encoded).toMatchObject({ width: 540, height: 1200 });
                const adbCalls = readFileSync(adbLog, 'utf8');
                expect(adbCalls).toContain('"push"');
                expect(adbCalls).toContain('"/data/local/tmp/scrcpy-server.jar"');
                expect(adbCalls).toContain('"tunnel_forward=true');
                expect(adbCalls).toContain('com.genymobile.scrcpy.Server 4.0');

                // The device's bytes became Annex-B access units on the engine.
                await waitFor('feeds', () => readFileSync(engineLog, 'utf8').split('\n').filter((line) => line.includes('session.feed')).length >= 2);
                const feeds = readFileSync(engineLog, 'utf8').split('\n')
                    .filter((line) => line.includes('session.feed')).map((line) => JSON.parse(line).params);
                expect(feeds[0].keyframe).toBe(false);
                expect(feeds[1].keyframe).toBe(true);
                for (const feed of feeds) {
                    expect(Buffer.from(feed.data_b64, 'base64').subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
                }

                // Engine input became device bytes: a touch, Back, text, and a
                // key-frame request became a stream reset.
                await waitFor('control bytes', () => Buffer.concat(received).length >= 50);
                const control = Buffer.concat(received);
                expect(control.subarray(0, 1)).toEqual(Buffer.from([0x11]));
                const touch = control.indexOf(Buffer.from([0x02, 0x00]));
                expect(touch).toBeGreaterThanOrEqual(0);
                expect(control.readBigUInt64BE(touch + 2)).toBe(0xfffffffffffffffDn);
                expect(control.readInt32BE(touch + 10)).toBe(100);
                expect(control.readInt32BE(touch + 14)).toBe(200);
                const backDown = control.indexOf(Buffer.from([0x04, 0x00]));
                const backUp = control.indexOf(Buffer.from([0x04, 0x01]));
                expect(backDown).toBeGreaterThanOrEqual(0);
                // Press order matters: down reaches the device before up.
                expect(backUp).toBeGreaterThan(backDown);
                expect(control.includes(Buffer.from('hi', 'utf8'))).toBe(true);

                // Signaling still flows: the offer arrives through poll.
                await waitFor('offer', async () => {
                    const polled = await watcher.targets.poll(opened.desktopId, 0);
                    return polled.events.some((event) => event.kind === 'offer');
                });
                const polled = await watcher.targets.poll(opened.desktopId, 0);
                expect(polled.events[0]).toMatchObject({ kind: 'offer', sdp: 'v=0 offer' });

                // Another device cannot drive this mirror: signaling with a
                // connection but the wrong owner is refused, while the owner
                // still flows.
                await expect(watcher.targets.poll(opened.desktopId, 0, 'conn-x', 'phone-2'))
                    .rejects.toThrow('belongs to another device');
                await watcher.targets.poll(opened.desktopId, 0, 'conn-1', 'phone-1');

                // Closing takes the mirror down: the forward is removed and
                // the engine session closed.
                await watcher.targets.close(opened.desktopId);
                await waitFor('forward removed', () => readFileSync(adbLog, 'utf8').includes('"--remove"'));
                expect(readFileSync(engineLog, 'utf8')).toContain('session.close');
                expect(watcher.mirrors.has('emulator-5572')).toBe(false);
            } finally {
                watcher.stop();
                await watcher.targets.closeAll();
                for (const socket of sockets) socket.destroy();
                backend.close();
            }
        } finally {
            delete process.env.MUXR_TEST_DEVICE_PORT;
            delete process.env.MUXR_TEST_RELAY_FILE;
            delete process.env.MUXR_TEST_ADB_LOG;
            delete process.env.MUXR_TEST_ENGINE_LOG;
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('marks the pane human while a control-scoped emulator target is live', async () => {
        const saved: PreviewLeaseSnapshot[] = [];
        const lease = new PreviewLeaseTracker({ idleMs: 60, persist: (snapshot) => saved.push(snapshot) });
        const targets = new AndroidPreviewTargets({
            mirrors: {
                open: async () => ({
                    session: {
                        generation: 1,
                        geometry: { source: { width: 540, height: 1200 }, encoded: { width: 540, height: 1200 }, origin: { x: 0, y: 0 } },
                        source: { kind: 'encoded', width: 540, height: 1200, origin: { x: 0, y: 0 } },
                    },
                    width: 540,
                    height: 1200,
                }),
                engineFor: () => ({ drainSignaling: () => [] }),
                close: async () => undefined,
                closeAll: async () => undefined,
            } as never,
            listSessions: async () => [{ id: 'sess-1', paneId: 'pane-1' }],
            previewFor: (paneId) => paneId === 'pane-1' ? { kind: 'android', since: Date.now() } : undefined,
            serialForPane: (paneId) => paneId === 'pane-1' ? 'emulator-5572' : undefined,
            lease,
        });
        const lastSaved = () => saved[saved.length - 1]?.panes['pane-1'];
        try {
            const watcher = await targets.openTarget('sess-1', { permissions: ['view'] }, { deviceId: 'phone-1' });
            expect(lease.controllerFor('pane-1')).toBeUndefined();
            expect(lastSaved()).toBeUndefined();

            const driver = await targets.openTarget('sess-1', { permissions: ['view', 'control'] }, { deviceId: 'phone-1' });
            expect(lease.controllerFor('pane-1')).toBe('human');
            expect(lastSaved()).toMatchObject({ controller: 'human' });

            await targets.close(watcher.desktopId);
            expect(lease.controllerFor('pane-1')).toBe('human');

            await targets.poll(driver.desktopId, 0);
            await new Promise((resolve) => setTimeout(resolve, 120));
            expect(lease.controllerFor('pane-1')).toBeUndefined();
            expect(lastSaved()).toBeUndefined();

            const second = await targets.openTarget('sess-1', { permissions: ['view', 'control'] }, { deviceId: 'phone-1' });
            expect(lease.controllerFor('pane-1')).toBe('human');
            await targets.close(second.desktopId);
            expect(lease.controllerFor('pane-1')).toBeUndefined();

            const third = await targets.openTarget('sess-1', { permissions: ['view', 'control'] }, { deviceId: 'phone-1' });
            expect(lease.controllerFor('pane-1')).toBe('human');
            await targets.revokeDevice('phone-1');
            expect(lease.controllerFor('pane-1')).toBeUndefined();
            expect(lastSaved()).toBeUndefined();
            await targets.close(third.desktopId);
        } finally {
            await targets.closeAll();
        }
    });
});
