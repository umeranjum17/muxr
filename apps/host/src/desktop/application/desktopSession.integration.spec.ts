import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DESKTOP_NO_PICTURE, desktopPortalBusy } from '@trymuxr/contract';

import { DesktopSessions, hostDesktopForPanes, type DesktopEngineOptions } from '../infrastructure/desktopSessions.js';

afterEach(() => vi.unstubAllEnvs());

// The session bus too: a portal open pings the real desktop's portal backends otherwise.
const HOST_SCREEN_ENV = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'MUXR_DESKTOP_SOURCE', 'MUXR_DESKTOP_X11_DISPLAY', 'PATH', 'DBUS_SESSION_BUS_ADDRESS'];

/** The host's own environment is the only one the desktop reads: stub it for this case, unset keys cleared. */
function hostDesktop(options: DesktopEngineOptions, environment: NodeJS.ProcessEnv, x11SocketDirectory?: string): DesktopSessions {
    const cleared = Object.fromEntries(HOST_SCREEN_ENV.map((name) => [name, '']));
    for (const [name, value] of Object.entries({ ...cleared, ...environment })) vi.stubEnv(name, value ?? '');
    return new DesktopSessions(options, x11SocketDirectory);
}

/**
 * The whole host-side desktop path, against a stub engine.
 *
 * A real engine is a compiled binary and a real desktop, neither of which
 * belongs in a suite. What this drives is the part that can silently be wrong:
 * the request names and parameter shapes the host sends, the notifications it
 * turns back into contract events, and the teardown. A stub that speaks the
 * documented protocol fails loudly when any of those drift, which is exactly
 * what a demo would otherwise discover in front of the user.
 */
const STUB = `
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const log = process.argv[2];
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const session = { id: 'engine-session-1', generation: 1 };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify(request) + '\\n');
  switch (request.method) {
    case 'hello':
      return out({ id: request.id, result: {
        protocol: 2, engine: 'stub/0', platform: 'linux', session: { kind: 'wayland' },
        capture: { mechanism: 'stub', formats: [], cursor: 'embedded', audio: false },
        encode: { codecs: ['vp9'], hardware: false },
        input: { mechanism: 'stub', pointer: true, wheel: true, keyboard: true, text: ['latin1'], unavailable_reason: null, grant: 'granted' },
        clipboard: { read: true, write: true, mime: [], maxBytes: 1024 },
      } });
    case 'capabilities':
      return out({ id: request.id, result: {
        protocol: 2, engine: 'stub/0', platform: 'linux', session: { kind: 'wayland' },
        capture: { mechanism: 'stub', formats: [], cursor: 'embedded', audio: false },
        encode: { codecs: ['vp9'], hardware: false },
        input: { mechanism: 'stub', pointer: true, wheel: true, keyboard: true, text: ['latin1'], unavailable_reason: null, grant: 'granted' },
        clipboard: { read: true, write: true, mime: [], maxBytes: 1024 },
      } });
    case 'session.open':
      setTimeout(() => out({ event: 'session.description', params: { sessionId: session.id, generation: 1, description: { type: 'offer', sdp: 'v=0 offer' } } }), 5);
      setTimeout(() => out({ event: 'session.candidate', params: { sessionId: session.id, generation: 1, candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } }), 10);
      return setTimeout(() => out({ id: request.id, result: {
        sessionId: session.id, generation: 1,
        source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } },
        geometry: { source: { width: 2560, height: 1440 }, encoded: { width: 1280, height: 720 }, origin: { x: 0, y: 0 } },
      } }), 1);
    case 'session.description':
      return out({ id: request.id, result: { accepted: true } });
    case 'session.candidate':
      return out({ id: request.id, result: { accepted: true } });
    case 'session.close':
      return out({ id: request.id, result: { closed: true } });
    case 'shutdown':
      out({ id: request.id, result: { closed: true } });
      process.exit(0);
    default:
      return out({ id: request.id, error: { code: 'operation', message: 'unknown ' + request.method } });
  }
});
`;

function stubEngine(): { path: string; log: string; sent: () => string[] } {
    const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
    const scriptPath = join(directory, 'engine.cjs');
    const log = join(directory, 'received.jsonl');
    writeFileSync(scriptPath, STUB);
    writeFileSync(log, '');
    return {
        path: scriptPath,
        log,
        sent: () => readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== ''),
    };
}

// The stub is a script, not the engine binary, so this drives the same code path
// the host uses in production with one process argument.
// A Wayland desktop, so the host offers the portal whatever machine runs this.
const PORTAL_HOST: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: 'wayland-0' };

function sessionsFor(stub: { path: string; log: string }): DesktopSessions {
    return hostDesktop({
        enginePath: process.execPath,
        engineArguments: [stub.path, stub.log],
    }, PORTAL_HOST);
}

/** Just enough of the D-Bus wire format to own a name and answer a ping. */
class Wire {
    readonly bytes: number[] = [];
    align(to: number): void { while (this.bytes.length % to !== 0) this.bytes.push(0); }
    u32(value: number): void { this.align(4); const word = Buffer.alloc(4); word.writeUInt32LE(value); this.bytes.push(...word); }
    string(value: string): void { this.u32(Buffer.byteLength(value)); this.bytes.push(...Buffer.from(value), 0); }
    signature(value: string): void { this.bytes.push(value.length, ...Buffer.from(value), 0); }
}

function busMessage(type: 1 | 2, serial: number, fields: Array<[number, string, (wire: Wire) => void]>, body?: { signature: string; write: (wire: Wire) => void }): Buffer {
    const payload = new Wire();
    body?.write(payload);
    const header = new Wire();
    for (const [code, signature, write] of [...fields, ...(body === undefined ? [] : [[8, 'g', (wire: Wire) => wire.signature(body.signature)] as const])]) {
        header.align(8);
        header.bytes.push(code);
        header.signature(signature);
        write(header);
    }
    const message = new Wire();
    message.bytes.push(0x6c, type, 0, 1);
    message.u32(payload.bytes.length);
    message.u32(serial);
    message.u32(header.bytes.length);
    message.bytes.push(...header.bytes);
    message.align(8);
    message.bytes.push(...payload.bytes);
    return Buffer.from(message.bytes);
}

function busCall(serial: number, member: string, body?: { signature: string; write: (wire: Wire) => void }): Buffer {
    return busMessage(1, serial, [
        [1, 'o', (wire) => wire.string('/org/freedesktop/DBus')],
        [2, 's', (wire) => wire.string('org.freedesktop.DBus')],
        [3, 's', (wire) => wire.string(member)],
        [6, 's', (wire) => wire.string('org.freedesktop.DBus')],
    ], body);
}

/** A connection owning `name`: a live backend answers pings, a wedged one reads and never replies. */
function busNameOwner(path: string, name: string, answers: boolean): Socket {
    const socket = connect(path);
    let authed = false;
    let pending = Buffer.alloc(0);
    let serial = 3;
    socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(process.getuid!())).toString('hex')}\r\n`);
    socket.on('data', (chunk: Buffer) => {
        if (!authed) {
            authed = true;
            socket.write('BEGIN\r\n');
            socket.write(busCall(1, 'Hello'));
            socket.write(busCall(2, 'RequestName', { signature: 'su', write: (wire) => { wire.string(name); wire.u32(4); } }));
            return;
        }
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 16) {
            const fieldsLength = pending.readUInt32LE(12);
            const total = 16 + Math.ceil(fieldsLength / 8) * 8 + pending.readUInt32LE(4);
            if (pending.length < total) return;
            const message = pending.subarray(0, total);
            pending = pending.subarray(total);
            if (!answers || message[1] !== 1) continue;
            const fields: Record<number, string> = {};
            for (let at = 16; at < 16 + fieldsLength;) {
                at = Math.ceil(at / 8) * 8;
                const code = message[at]!;
                const kind = String.fromCharCode(message[at + 2]!);
                at += 4;
                if (kind === 'u') { at = Math.ceil(at / 4) * 4 + 4; continue; }
                const length = kind === 'g' ? message[at]! : message.readUInt32LE(at = Math.ceil(at / 4) * 4);
                const start = at + (kind === 'g' ? 1 : 4);
                fields[code] = message.subarray(start, start + length).toString();
                at = start + length + 1;
            }
            if (fields[3] !== 'Ping' || fields[7] === undefined) continue;
            const caller = fields[7];
            socket.write(busMessage(2, serial++, [
                [5, 'u', (wire) => wire.u32(message.readUInt32LE(8))],
                [6, 's', (wire) => wire.string(caller)],
            ]));
        }
    });
    return socket;
}

const busTools = spawnSync('dbus-daemon', ['--version']).status === 0 && spawnSync('busctl', ['--version']).status === 0;

describe('desktop sessions, host side', () => {
    it('reports capabilities, opens a session, returns its notifications and closes it', async () => {
        const stub = stubEngine();
        const desktop = sessionsFor(stub);

        const capabilities = await desktop.capabilities();
        expect(capabilities).toMatchObject({ available: true, input: true, clipboard: true, codec: 'vp9' });

        const opened = await desktop.open({ permissions: ['view', 'control', 'clipboard'], maxWidth: 640, maxHeight: 480, bitrateKbps: 2000, maxFps: 15 });
        expect(opened.geometry.encoded).toEqual({ width: 1280, height: 720 });
        expect(opened.source.width).toBe(2560);

        // The offer and the candidate reach the client as contract events, not as
        // the engine's own vocabulary.
        await new Promise((resolve) => setTimeout(resolve, 60));
        const first = await desktop.poll(opened.desktopId, 0);
        expect(first.events.map((event) => event.kind)).toEqual(['offer', 'candidate']);
        expect(first.events[0]).toMatchObject({ kind: 'offer', sdp: 'v=0 offer' });
        expect(first.events[1]).toMatchObject({ kind: 'candidate', candidate: 'candidate:1', sdpMid: '0' });

        // A cursor the client already saw does not replay.
        const drained = await desktop.poll(opened.desktopId, first.cursor);
        expect(drained.events).toEqual([]);

        await desktop.answer(opened.desktopId, 'v=0 answer');
        await desktop.candidate(opened.desktopId, 'candidate:2', '0', 0);
        await desktop.close(opened.desktopId);

        const sent = stub.sent().map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
        expect(sent.map((request) => request.method)).toEqual([
            'hello',
            'capabilities',
            'session.open',
            'session.description',
            'session.candidate',
            'session.close',
            'shutdown',
        ]);
        expect(sent[2]?.params).toMatchObject({
            // @desklink/host 0.5.0 no longer sends permissions on the wire:
            // pairing grants all available access, so the client drops the
            // deprecated field and the engine ignores it.
            // The engine reads the snake_case wire names; a camelCase key is
            // ignored, not refused, so this is the only place the drop shows.
            max_width: 640,
            max_height: 480,
            bitrate_kbps: 2000,
            max_fps: 15,
            ttl_seconds: 3600,
        });
        // The answer and candidate carry the engine's own session id, never the
        // host's opaque handle.
        expect(sent[3]?.params).toMatchObject({ session_id: 'engine-session-1', description: { type: 'answer', sdp: 'v=0 answer' } });
        expect(sent[4]?.params).toMatchObject({ session_id: 'engine-session-1', candidate: 'candidate:2', sdp_mid: '0', sdp_m_line_index: 0 });
    }, 20_000);

    it('keeps a portal grant only from an open that started capture, and asks again when a restored one shows nothing', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-restore-'));
        const script = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        const grantPath = join(directory, 'desktop', 'portal-restore-token');
        writeFileSync(log, '');
        // The portal hands back a grant before capture starts, whatever happens
        // next; the engine answers an open only once capture has a frame.
        // 'closed-window' restores a source that never sends a picture;
        // 'starved' is a fresh choice another screencast keeps from starting
        // once; 'nothing' never starts at all.
        writeFileSync(script, STUB.replace("    case 'session.open':", `
    case 'session.open': {
      const token = request.params.restore_token;
      const mode = require('node:fs').readFileSync(process.argv[3], 'utf8');
      out({ event: 'session.restoreToken', params: { sessionId: session.id, token: 'earned-' + (token ?? 'picker') } });
      if (token === 'closed-window' || mode === 'nothing' || (mode === 'starved' && token === undefined)) {
        return out({ id: request.id, error: { code: 'source', message: 'capture did not start within 10s' } });
      }
    }
    case 'unused':`));
        const mode = join(directory, 'mode');
        const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [script, log, mode], stateRoot: directory }, PORTAL_HOST);
        const opens = () => readFileSync(log, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as { method: string; params: { restore_token?: string } })
            .filter((request) => request.method === 'session.open')
            .map((request) => request.params.restore_token ?? 'picker');
        const grant = () => existsSync(grantPath) ? readFileSync(grantPath, 'utf8') : null;
        try {
            // A fresh choice starved once retries with its own grant, no second
            // picker, and keeps the grant of the open that started.
            writeFileSync(mode, 'starved');
            await desktop.open({ permissions: ['view'], awaitConsent: true });
            await desktop.closeAll();
            expect(opens()).toEqual(['picker', 'earned-picker']);
            expect(grant()).toBe('earned-earned-picker');

            // The window it restores has closed since: the host asks again with
            // the picker instead of saving or replaying the dead grant.
            writeFileSync(mode, 'shown');
            writeFileSync(grantPath, 'closed-window', { mode: 0o600 });
            const recovered = await desktop.open({ permissions: ['view'], awaitConsent: true });
            expect(recovered.source.kind).toBe('monitor');
            expect(grant()).toBe('earned-picker');
            await desktop.closeAll();
            expect(opens().slice(2)).toEqual(['closed-window', 'picker']);

            // Nothing ever shows: the phone is told so at once, in the words it
            // knows, and the next open asks again.
            writeFileSync(mode, 'nothing');
            await expect(desktop.open({ permissions: ['view'], awaitConsent: true }))
                .rejects.toMatchObject({ code: 'source', message: DESKTOP_NO_PICTURE });
            expect(opens().slice(4)).toEqual(['earned-picker', 'picker']);
            expect(grant()).toBeNull();
        } finally {
            await desktop.closeAll();
            rmSync(directory, { recursive: true, force: true });
        }
    }, 20_000);

    it('keeps a private rotating portal grant across host restarts without sending it to the phone', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-grant-'));
        const scriptPath = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        const grantDirectory = join(directory, 'desktop');
        const grantPath = join(grantDirectory, 'portal-restore-token');
        writeFileSync(log, '');
        writeFileSync(scriptPath, STUB.replace("    case 'session.open':", `
    case 'session.open':
      if (request.params.source?.kind !== 'x11') {
        if (require('node:fs').existsSync(process.argv[3])) {
          return out({ id: request.id, error: { code: 'replayed-token', message: 'grant was not consumed before opening' } });
        }
        // Model a portal which cannot restore the source and whose normal
        // consent picker is then cancelled. No automatic retry is appropriate.
        if (request.params.restore_token === 'test-grant-2') {
          return out({ id: request.id, error: { code: 'source', message: 'screen capture was not granted' } });
        }
        out({ event: 'session.restoreToken', params: {
          sessionId: session.id,
          token: request.params.restore_token === 'test-grant-1' ? 'test-grant-2' : 'test-grant-1',
        } });
      }
`));
        const diagnostics: string[] = [];
        const hosts: DesktopSessions[] = [];
        const restart = (environment: NodeJS.ProcessEnv = PORTAL_HOST) => {
            const desktop = hostDesktop({
                enginePath: process.execPath,
                engineArguments: [scriptPath, log, grantPath],
                stateRoot: directory,
                onDiagnostic: (line) => diagnostics.push(line),
            }, environment);
            hosts.push(desktop);
            return desktop;
        };
        try {
            const first = restart();
            const opened = await first.open({ permissions: ['view', 'control'] });
            // Persist before the first poll, not when the phone happens to ask.
            expect(readFileSync(grantPath, 'utf8')).toBe('test-grant-1');
            expect(statSync(grantDirectory).mode & 0o777).toBe(0o700);
            expect(statSync(grantPath).mode & 0o777).toBe(0o600);
            await new Promise((resolve) => setTimeout(resolve, 60));
            const polled = await first.poll(opened.desktopId, 0);
            expect(polled.events.map((event) => event.kind)).toEqual(['offer', 'candidate']);
            expect(JSON.stringify({ opened, polled })).not.toContain('test-grant');
            await first.closeAll();

            const restored = restart();
            await restored.open({ permissions: ['view'] });
            await restored.closeAll(); // No poll: the replacement must already be durable.
            expect(readFileSync(grantPath, 'utf8')).toBe('test-grant-2');
            expect(statSync(grantPath).mode & 0o777).toBe(0o600);
            expect(readdirSync(grantDirectory)).toEqual(['portal-restore-token']);

            const x11 = restart({ MUXR_DESKTOP_SOURCE: 'x11' });
            expect((await x11.capabilities()).clipboard).toBe(false);
            await expect(x11.open({ permissions: ['view', 'clipboard'] })).rejects.toMatchObject({ code: 'clipboard-unsupported' });
            await x11.open({ permissions: ['view'] });
            await x11.closeAll();
            expect(readFileSync(grantPath, 'utf8')).toBe('test-grant-2');

            const revoked = restart();
            await expect(revoked.open({ permissions: ['view'] })).rejects.toMatchObject({ code: 'source' });
            expect(existsSync(grantPath)).toBe(false);
            // A deliberate later attempt asks for ordinary consent, without
            // replaying the revoked/used token or hiding the previous refusal.
            await revoked.open({ permissions: ['view'] });
            expect(readFileSync(grantPath, 'utf8')).toBe('test-grant-1');
            await revoked.revokeDevice('removed-phone', true);
            expect(existsSync(grantPath)).toBe(false);
            await revoked.open({ permissions: ['view'] });
            await revoked.closeAll();
            const requests = readFileSync(log, 'utf8').trim().split('\n')
                .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
                .filter((request) => request.method === 'session.open');
            expect(requests.map((request) => request.params.restore_token)).toEqual([
                undefined, 'test-grant-1', undefined, 'test-grant-2', undefined, undefined,
            ]);
            expect(diagnostics.join('\n')).not.toContain('test-grant');
        } finally {
            for (const host of hosts) await host.closeAll();
            rmSync(directory, { recursive: true, force: true });
        }
    }, 20_000);

    it('keeps the engine waiting on a slow screen-sharing approval, and stops it at the consent window', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-consent-'));
        const scriptPath = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        const approval = join(directory, 'approved');
        const pids = join(directory, 'pids');
        writeFileSync(log, '');
        // The portal answers only once the person at the computer approves,
        // which here is a file the test writes whenever it chooses.
        writeFileSync(scriptPath, `require('node:fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');\n` + STUB.replace("    case 'session.open':", `
    case 'session.open': {
      const waiting = setInterval(() => {
        if (!require('node:fs').existsSync(${JSON.stringify(approval)})) return;
        clearInterval(waiting);
        out({ event: 'session.restoreToken', params: { sessionId: session.id, token: 'approved-grant' } });
        out({ id: request.id, result: {
          sessionId: session.id, generation: 1,
          source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } },
          geometry: { source: { width: 2560, height: 1440 }, encoded: { width: 1280, height: 720 }, origin: { x: 0, y: 0 } },
        } });
      }, 20);
      return;
    }
    case 'unused':`));
        const desktop = hostDesktop({
            enginePath: process.execPath,
            engineArguments: [scriptPath, log],
            stateRoot: directory,
        }, PORTAL_HOST);
        const opens = () => readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('"session.open"')).length;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            // A person takes a minute to find the prompt: long past the
            // engine's ordinary request timeout, so the same engine must still
            // be there when they approve.
            const slow = desktop.open({ permissions: ['view'], awaitConsent: true });
            await vi.waitFor(() => expect(opens()).toBe(1), { timeout: 5000 });
            await vi.advanceTimersByTimeAsync(60_000);
            writeFileSync(approval, '');
            const opened = await slow;
            expect(opened.desktopId).toBeTruthy();
            expect(readFileSync(join(directory, 'desktop', 'portal-restore-token'), 'utf8')).toBe('approved-grant');
            expect(readFileSync(pids, 'utf8').trim().split('\n')).toHaveLength(1);
            await desktop.closeAll();

            // Nobody answers: the host gives up at the consent window with the
            // typed refusal, and the engine holding the prompt is gone.
            rmSync(approval);
            const unanswered = desktop.open({ permissions: ['view'], awaitConsent: true });
            const refused = expect(unanswered).rejects.toMatchObject({ code: 'consent-timeout' });
            await vi.waitFor(() => expect(opens()).toBe(2), { timeout: 5000 });
            await vi.advanceTimersByTimeAsync(111_000);
            await refused;
            const pid = Number(readFileSync(pids, 'utf8').trim().split('\n')[1]);
            await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });

            // A phone that does not say it waits (an older app, with a shorter
            // request timeout of its own) is answered within that timeout.
            const older = desktop.open({ permissions: ['view'] });
            const answered = expect(older).rejects.toMatchObject({ code: 'consent-timeout' });
            await vi.waitFor(() => expect(opens()).toBe(3), { timeout: 5000 });
            await vi.advanceTimersByTimeAsync(16_000);
            await answered;
        } finally {
            vi.useRealTimers();
            await desktop.closeAll();
            rmSync(directory, { recursive: true, force: true });
        }
    }, 20_000);

    it.skipIf(!busTools)('refuses at once while a portal backend is wedged, and opens once it answers again', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-portal-busy-'));
        const busPath = join(directory, 'bus');
        // A private session bus: never the real desktop's.
        const daemon = spawn('dbus-daemon', ['--session', '--nofork', `--address=unix:path=${busPath}`], { stdio: 'ignore' });
        const owners: Socket[] = [];
        try {
            await vi.waitFor(() => expect(existsSync(busPath)).toBe(true), { timeout: 5000 });
            const stub = stubEngine();
            const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [stub.path, stub.log] },
                { ...PORTAL_HOST, PATH: process.env.PATH, DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}` });
            owners.push(busNameOwner(busPath, 'org.freedesktop.impl.portal.desktop.alive', true));
            const wedged = busNameOwner(busPath, 'org.freedesktop.impl.portal.desktop.test', false);
            owners.push(wedged);
            const owned = () => spawnSync('busctl', ['--user', 'list', '--acquired', '--no-legend', '--no-pager'], { encoding: 'utf8' }).stdout;
            await vi.waitFor(() => expect(owned()).toMatch(/desktop\.alive[\s\S]*desktop\.test|desktop\.test[\s\S]*desktop\.alive/), { timeout: 5000 });

            // The wedged backend's share picker would never appear, so the
            // phone hears why at once, not after the whole consent wait.
            const started = Date.now();
            await expect(desktop.open({ permissions: ['view'], awaitConsent: true })).rejects.toMatchObject({
                code: 'portal-busy',
                message: desktopPortalBusy('systemctl --user restart xdg-desktop-portal-test'),
            });
            expect(Date.now() - started).toBeLessThan(10_000);
            expect(stub.sent().filter((line) => line.includes('"session.open"'))).toEqual([]);

            // Restarted, the backend answers, and the open goes through.
            wedged.destroy();
            await vi.waitFor(() => expect(owned()).not.toMatch(/desktop\.test/), { timeout: 5000 });
            const opened = await desktop.open({ permissions: ['view'], awaitConsent: true });
            expect(opened.desktopId).toBeTruthy();
            await desktop.closeAll();
        } finally {
            for (const owner of owners) owner.destroy();
            daemon.kill();
            rmSync(directory, { recursive: true, force: true });
        }
    }, 30_000);

    it('refuses control up front when the machine has no input backend', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
        const scriptPath = join(directory, 'engine.cjs');
        writeFileSync(
            scriptPath,
            STUB.replaceAll('pointer: true, wheel: true, keyboard: true', 'pointer: false, wheel: false, keyboard: false'),
        );
        const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, join(directory, 'received.jsonl')] }, PORTAL_HOST);
        writeFileSync(join(directory, 'received.jsonl'), '');

        const capabilities = await desktop.capabilities();
        expect(capabilities).toMatchObject({ available: true, input: false });

        // The user must be told the desktop is view-only, not handed controls
        // that would silently do nothing.
        await expect(desktop.open({ permissions: ['view', 'control'] })).rejects.toMatchObject({ code: 'input-unavailable' });
        await desktop.closeAll();
    }, 20_000);

    it('delivers the engine-death revocation instead of dropping the session', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
        const scriptPath = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        writeFileSync(
            scriptPath,
            STUB.replace(
                "    case 'session.open':",
                "    case 'session.open':\n      setTimeout(() => process.exit(3), 50);",
            ),
        );
        writeFileSync(log, '');
        const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

        const opened = await desktop.open({ permissions: ['view'] });
        // The engine dies right after it answers. The session record must survive
        // the exit so the client can be told the desktop is gone.
        await new Promise((resolve) => setTimeout(resolve, 400));

        const polled = await desktop.poll(opened.desktopId, 0);
        expect(polled.events).toContainEqual({ kind: 'revoked', reason: 'the desktop engine stopped' });
        await desktop.closeAll();
    }, 20_000);

    it('allows control on an X11 host that has no uinput access, configured or found on its own', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'x-'));
        const scriptPath = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        const runtime = join(directory, 'run');
        const socket = createServer();
        const hosts: DesktopSessions[] = [];
        try {
            mkdirSync(runtime);
            writeFileSync(
                scriptPath,
                STUB.replaceAll('pointer: true, wheel: true, keyboard: true', 'pointer: false, wheel: false, keyboard: false'),
            );
            for (const environment of [{ MUXR_DESKTOP_SOURCE: 'x11' }, { DISPLAY: ':77', XDG_RUNTIME_DIR: runtime }] as NodeJS.ProcessEnv[]) {
                writeFileSync(log, '');
                const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, environment);
                hosts.push(desktop);
                expect(await desktop.capabilities()).toMatchObject({ available: true, input: true });
                const opened = await desktop.open({ permissions: ['view', 'control'] });
                expect(opened.geometry.encoded).toEqual({ width: 1280, height: 720 });
                await desktop.closeAll();
                const sent = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
                expect(sent.find((request) => request.method === 'session.open')?.params).toMatchObject({
                    source: environment.DISPLAY === undefined ? { kind: 'x11' } : { kind: 'x11', display: ':77' },
                });
            }

            writeFileSync(join(runtime, 'wayland-1'), '');
            const environment = { DISPLAY: ':0', XDG_RUNTIME_DIR: runtime };
            const stale = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, environment);
            hosts.push(stale);
            expect(await stale.capabilities()).toMatchObject({ available: true, input: true });
            await stale.open({ permissions: ['view', 'control'] });
            const sent = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
            expect(sent.filter((request) => request.method === 'session.open').at(-1)?.params).toMatchObject({ source: { kind: 'x11', display: ':0' } });

            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject);
                socket.listen(join(runtime, 'wayland-2'), resolve);
            });
            const wayland = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, environment);
            hosts.push(wayland);
            expect(await wayland.capabilities()).toMatchObject({ available: true, input: false });
            await wayland.open({ permissions: ['view'] });
            const withSocket = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
            expect(withSocket.filter((request) => request.method === 'session.open').at(-1)?.params).not.toHaveProperty('source');
        } finally {
            for (const host of hosts) await host.closeAll();
            if (socket.listening) await new Promise<void>((resolve) => socket.close(() => resolve()));
            rmSync(directory, { recursive: true, force: true });
        }
    }, 20_000);

    it('discovers only the host account’s X socket while honoring explicit displays', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'x-'));
        const socket = createServer();
        const uid = process.getuid!();
        const hostUid = vi.spyOn(process, 'getuid');
        const log = join(directory, 'received.jsonl');
        const script = join(directory, 'engine.cjs');
        writeFileSync(script, STUB.replaceAll('pointer: true, wheel: true, keyboard: true', 'pointer: false, wheel: false, keyboard: false'));
        writeFileSync(log, '');
        const options = { enginePath: process.execPath, engineArguments: [script, log] };
        const hosts: DesktopSessions[] = [];
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject);
                socket.listen(join(directory, 'X0'), resolve);
            });
            hostUid.mockReturnValue(uid + 1);
            const foreign = hostDesktop(options, { XDG_RUNTIME_DIR: directory }, directory);
            hosts.push(foreign);
            expect(await foreign.capabilities()).toMatchObject({ available: true, input: false });
            // Another account's display is not this host's screen, and there is nothing else to show.
            await expect(foreign.open({ permissions: ['view'] })).rejects.toMatchObject({ code: 'no-screen' });

            const explicit = hostDesktop(options, { DISPLAY: ':88' }, directory);
            hosts.push(explicit);
            expect(await explicit.capabilities()).toMatchObject({ available: true, input: true });
            await explicit.open({ permissions: ['view', 'control'] });
            const configured = hostDesktop(options, { MUXR_DESKTOP_SOURCE: 'x11', MUXR_DESKTOP_X11_DISPLAY: ':99' }, directory);
            hosts.push(configured);
            await configured.open({ permissions: ['view'] });

            hostUid.mockReturnValue(uid);
            const owned = hostDesktop(options, { XDG_RUNTIME_DIR: directory }, directory);
            hosts.push(owned);
            expect(await owned.capabilities()).toMatchObject({ available: true, input: true });
            await owned.open({ permissions: ['view', 'control'] });
            const sources = readFileSync(log, 'utf8').trim().split('\n')
                .map((line) => JSON.parse(line) as { method: string; params: { source?: unknown } })
                .filter((request) => request.method === 'session.open')
                .map((request) => request.params.source);
            expect(sources).toEqual([{ kind: 'x11', display: ':88' }, { kind: 'x11', display: ':99' }, { kind: 'x11', display: ':0' }]);
        } finally {
            hostUid.mockRestore();
            for (const host of hosts) await host.closeAll();
            await new Promise<void>((resolve) => socket.close(() => resolve()));
            rmSync(directory, { recursive: true, force: true });
        }
    }, 20_000);

    it('updates desktop permissions as a headless X display starts and stops', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'x-'));
        const socket = createServer();
        const script = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        writeFileSync(script, STUB.replaceAll('pointer: true, wheel: true, keyboard: true', 'pointer: false, wheel: false, keyboard: false'));
        writeFileSync(log, '');
        const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [script, log] }, { XDG_RUNTIME_DIR: directory }, directory);
        try {
            expect(await desktop.capabilities()).toMatchObject({ input: false, clipboard: true });
            await expect(desktop.open({ permissions: ['view'] })).rejects.toMatchObject({ code: 'no-screen' });
            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject);
                socket.listen(join(directory, 'X77'), resolve);
            });
            expect(await desktop.capabilities()).toMatchObject({ input: true, clipboard: false });
            await desktop.open({ permissions: ['view', 'control'] });
            const requests = readFileSync(log, 'utf8').trim().split('\n')
                .map((line) => JSON.parse(line) as { method: string; params: { source?: unknown } })
                .filter((request) => request.method === 'session.open');
            expect(requests.at(-1)?.params.source).toEqual({ kind: 'x11', display: ':77' });

            await new Promise<void>((resolve) => socket.close(() => resolve()));
            expect(await desktop.capabilities()).toMatchObject({ input: false, clipboard: true });
            await expect(desktop.open({ permissions: ['view', 'control'] })).rejects.toMatchObject({ code: 'no-screen' });
        } finally {
            await desktop.closeAll();
            if (socket.listening) await new Promise<void>((resolve) => socket.close(() => resolve()));
            rmSync(directory, { recursive: true, force: true });
        }
    }, 20_000);

    it('gives a server without a screen its own display, or says what to install', async () => {
        // Outside the package, whose ESM scope would take the stand-in for a module.
        const directory = mkdtempSync(join(tmpdir(), 'v-'));
        const bin = join(directory, 'bin');
        const nodeBin = join(directory, 'node');
        const sockets = join(directory, 'x');
        const runtime = join(directory, 'run');
        for (const path of [bin, nodeBin, sockets, runtime]) mkdirSync(path);
        // Only node on PATH, so a real Xvfb on this machine is never found.
        symlinkSync(process.execPath, join(nodeBin, 'node'));
        const script = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        writeFileSync(script, STUB);
        writeFileSync(log, '');
        // A stand-in Xvfb: opens its display's socket and records each start.
        writeFileSync(join(bin, 'Xvfb'), `#!/usr/bin/env node
const { createServer } = require('node:net'), { appendFileSync, writeFileSync } = require('node:fs');
const number = process.argv[2].slice(1);
appendFileSync(${JSON.stringify(join(directory, 'starts'))}, number + '\\n');
writeFileSync(${JSON.stringify(join(directory, 'pid'))}, String(process.pid));
createServer().listen(${JSON.stringify(sockets)} + '/X' + number);
`);
        chmodSync(join(bin, 'Xvfb'), 0o755);
        const server = { XDG_RUNTIME_DIR: runtime, PATH: nodeBin };
        const opened = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
            .filter((request) => request.method === 'session.open').map((request) => request.params.source);
        try {
            const bare = hostDesktop({ enginePath: process.execPath, engineArguments: [script, log] }, server, sockets);
            await expect(bare.open({ permissions: ['view', 'control'] })).rejects.toMatchObject({ code: 'no-screen' });
            expect(opened()).toEqual([]);

            const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [script, log] }, { ...server, PATH: `${bin}:${server.PATH}` }, sockets);
            await desktop.open({ permissions: ['view', 'control'] });
            await desktop.closeAll();
            // Killed outright, as a reboot or a crash would: the next open starts it again.
            process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 'SIGKILL');
            await vi.waitFor(() => expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow());
            await desktop.open({ permissions: ['view', 'control'] });
            await desktop.closeAll();
            // Started twice, on the same free display number both times.
            const starts = readFileSync(join(directory, 'starts'), 'utf8').trim().split('\n');
            expect(starts).toHaveLength(2);
            expect(starts[1]).toBe(starts[0]);
            expect(opened()).toEqual(starts.map((number) => ({ kind: 'x11', display: `:${number}` })));

            desktop.stopVirtualDisplay();
            await vi.waitFor(() => expect(existsSync(join(sockets, `X${starts[0]}`))).toBe(false));
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 20_000);

    it('forgets the session record once the engine revokes it', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
        const scriptPath = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        writeFileSync(
            scriptPath,
            STUB.replace(
                "    case 'session.open':",
                "    case 'session.open':\n      setTimeout(() => out({ event: 'session.revoked', params: { sessionId: session.id, reason: 'the session lease expired' } }), 15);",
            ),
        );
        writeFileSync(log, '');
        const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

        const opened = await desktop.open({ permissions: ['view'] });
        await new Promise((resolve) => setTimeout(resolve, 80));

        const polled = await desktop.poll(opened.desktopId, 0);
        expect(polled.events).toContainEqual({ kind: 'revoked', reason: 'the session lease expired' });

        // The record is gone with the notification, so a later poll is refused
        // rather than serving an empty backlog forever.
        await expect(desktop.poll(opened.desktopId, polled.cursor)).rejects.toMatchObject({ code: 'session' });
        await desktop.closeAll();
    }, 20_000);

    it('re-probes the engine after a failed probe instead of caching the failure', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
        const scriptPath = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        writeFileSync(log, '');
        const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

        const failed = await desktop.capabilities();
        expect(failed).toMatchObject({ available: false });
        expect(failed.unavailableReason).toBeTruthy();
        // The reason is the start failure, not the generic missing-engine text.
        expect(failed.unavailableReason).not.toBe('The desktop engine is unavailable.');

        // The engine is built (or fixed) while the host keeps running. Tapping
        // Try again must ask again rather than replay the first answer.
        writeFileSync(scriptPath, STUB);
        expect(await desktop.capabilities()).toMatchObject({ available: true, input: true });

        await desktop.closeAll();
    }, 20_000);

    it('closes a portal session approved after its phone disconnects', async () => {
        const stub = stubEngine();
        writeFileSync(stub.path, STUB.replace('      } }), 1);', '      } }), 100);'));
        const desktop = sessionsFor(stub);
        let connected = true;
        const opening = desktop.open({ permissions: ['view'] }, {
            connectionId: 'connection-1', isConnected: () => connected,
        });
        const deadline = Date.now() + 5000;
        while (!stub.sent().some((line) => JSON.parse(line).method === 'session.open') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        connected = false;
        await expect(opening).rejects.toMatchObject({ code: 'session' });
        expect(stub.sent().map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }))
            .toContainEqual(expect.objectContaining({ method: 'session.close', params: { session_id: 'engine-session-1' } }));
        await desktop.closeAll();
    }, 20_000);

    it('does not attribute a queued revocation for an abandoned session to a new one', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
        const scriptPath = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        writeFileSync(
            scriptPath,
            STUB.replace(
                "const session = { id: 'engine-session-1', generation: 1 };",
                "const session = { id: '', generation: 1 }; let opened = 0;",
            ).replace(
                "    case 'session.open':",
                "    case 'session.open':\n      opened += 1; session.id = 'engine-session-' + opened;\n      if (opened === 1) setTimeout(() => out({ event: 'session.revoked', params: { sessionId: 'engine-session-1', reason: 'the session lease expired' } }), 30);\n      if (opened === 2) {\n        out({ event: 'session.description', params: { sessionId: session.id, generation: 1, description: { type: 'offer', sdp: 'v=0 offer' } } });\n        out({ event: 'session.candidate', params: { sessionId: session.id, generation: 1, candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } });\n        return setTimeout(() => out({ id: request.id, result: { sessionId: session.id, generation: 1, source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } }, geometry: { source: { width: 2560, height: 1440 }, encoded: { width: 1280, height: 720 }, origin: { x: 0, y: 0 } } } }), 80);\n      }", 
            ),
        );
        writeFileSync(log, '');
        const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

        // The phone opens once and is abandoned before it polls, so the engine's
        // lease revokes that session into the shared notification queue.
        const first = await desktop.open({ permissions: ['view'] });
        await new Promise((resolve) => setTimeout(resolve, 80));

        const opening = desktop.open({ permissions: ['view'] });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await desktop.poll(first.desktopId, 0);
        const second = await opening;
        await new Promise((resolve) => setTimeout(resolve, 40));

        const polled = await desktop.poll(second.desktopId, 0);
        expect(polled.events.some((event) => event.kind === 'revoked')).toBe(false);
        // The new session's own notifications are kept, not filtered away with
        // the abandoned session's.
        expect(polled.events.map((event) => event.kind)).toEqual(['offer', 'candidate']);
        // The new record survives the poll that a mis-attributed revocation would
        // have deleted it on.
        await expect(desktop.poll(second.desktopId, polled.cursor)).resolves.toBeDefined();

        await desktop.closeAll();
    }, 20_000);

    it('revokes the previous phone even when replacement consent is refused', async () => {
        const stub = stubEngine();
        writeFileSync(stub.path, STUB.replace("const session = { id: 'engine-session-1', generation: 1 };",
            "const session = { id: 'engine-session-1', generation: 1 }; let opens = 0;",
        ).replace("    case 'session.open':", `    case 'session.open':
      if (++opens === 2) return out({ id: request.id, error: { code: 'source', message: 'screen capture was not granted' } });`));
        const desktop = sessionsFor(stub);
        try {
            const first = await desktop.open({ permissions: ['view'] });
            await expect(desktop.open({ permissions: ['view'] })).rejects.toMatchObject({ code: 'source' });
            const polled = await desktop.poll(first.desktopId, 0);
            expect(polled.events).toContainEqual({ kind: 'revoked', reason: 'another device opened this computer' });
            await expect(desktop.poll(first.desktopId, polled.cursor)).rejects.toMatchObject({ code: 'session' });
        } finally {
            await desktop.closeAll();
        }
    }, 20_000);

    it('keeps a newly opening desktop alive during old relay-loss cleanup', async () => {
        const stub = stubEngine();
        writeFileSync(stub.path, STUB.replace('      } }), 1);', '      } }), 150);').replace(
            "    case 'session.close':\n      return out({ id: request.id, result: { closed: true } });",
            "    case 'session.close':\n      return setTimeout(() => out({ id: request.id, result: { closed: true } }), 80);",
        ));
        const desktop = sessionsFor(stub);
        try {
            const first = await desktop.open({ permissions: ['view'] });
            const cleanup = desktop.closeAll();
            const deadline = Date.now() + 5000;
            while (!stub.sent().some((line) => JSON.parse(line).method === 'session.close') && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(stub.sent().some((line) => JSON.parse(line).method === 'session.close')).toBe(true);
            const opening = desktop.open({ permissions: ['view'] });
            await cleanup;
            expect(stub.sent().some((line) => JSON.parse(line).method === 'shutdown')).toBe(false);
            const second = await opening;
            expect((await desktop.poll(second.desktopId, 0)).events).toContainEqual(expect.objectContaining({ kind: 'offer' }));
            await desktop.close(second.desktopId);
            expect(stub.sent().some((line) => JSON.parse(line).method === 'shutdown')).toBe(true);
            await expect(desktop.poll(first.desktopId, 0)).rejects.toMatchObject({ code: 'session' });
        } finally {
            await desktop.closeAll();
        }
    }, 20_000);

    it('tears down an engine that refuses the handshake instead of leaving it running', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
        const scriptPath = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        writeFileSync(
            scriptPath,
            STUB.replace(
                "    case 'hello':",
                "    case 'hello':\n      return out({ id: request.id, error: { code: 'unsupported-protocol', message: 'this engine speaks an older protocol' } });",
            ),
        );
        writeFileSync(log, '');
        const desktop = hostDesktop({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

        expect(await desktop.capabilities()).toMatchObject({ available: false });

        const sent = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string });
        expect(sent.map((request) => request.method)).toContain('shutdown');
        await desktop.closeAll();
    }, 20_000);
});

describe('panes share the host desktop selection', () => {
    // Env-only by construction: no X socket can influence the pane predicate, so the socket case is not tested here.
    it('gives panes the X display the host selected, and no screen on a host with none', () => {
        expect(hostDesktopForPanes({ MUXR_DESKTOP_SOURCE: 'x11', MUXR_DESKTOP_X11_DISPLAY: ':99' })).toEqual({ screen: true, x11Display: ':99' });
        expect(hostDesktopForPanes({})).toEqual({ screen: false });
        expect(hostDesktopForPanes({ MUXR_DESKTOP_SOURCE: 'x11' })).toEqual({ screen: false });
        expect(hostDesktopForPanes({ MUXR_DESKTOP_SOURCE: 'x11', DISPLAY: ':0' })).toEqual({ screen: true, x11Display: ':0' });
        expect(hostDesktopForPanes({ WAYLAND_DISPLAY: 'wayland-0' })).toEqual({ screen: true });
        expect(hostDesktopForPanes({ MUXR_DESKTOP_SOURCE: 'portal', DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0' })).toEqual({ screen: true });
        expect(hostDesktopForPanes({ MUXR_DESKTOP_SOURCE: 'portal', DISPLAY: ':1' })).toEqual({ screen: false });
        expect(hostDesktopForPanes({ MUXR_DESKTOP_X11_DISPLAY: ':99', DISPLAY: ':0' })).toEqual({ screen: true, x11Display: ':0' });
        expect(hostDesktopForPanes({ MUXR_DESKTOP_SOURCE: 'x11', WAYLAND_DISPLAY: 'wayland-0' })).toEqual({ screen: false });
    });
});
