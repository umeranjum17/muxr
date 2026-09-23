import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { DesktopSessions } from '../infrastructure/desktopSessions.js';

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
    return new DesktopSessions({
        enginePath: process.execPath,
        engineArguments: [stub.path, stub.log],
    }, PORTAL_HOST);
}

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
            permissions: ['view', 'control', 'clipboard'],
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
            const desktop = new DesktopSessions({
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
            await revoked.closeAll();
            const requests = readFileSync(log, 'utf8').trim().split('\n')
                .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
                .filter((request) => request.method === 'session.open');
            expect(requests.map((request) => request.params.restore_token)).toEqual([
                undefined, 'test-grant-1', undefined, 'test-grant-2', undefined,
            ]);
            expect(diagnostics.join('\n')).not.toContain('test-grant');
        } finally {
            for (const host of hosts) await host.closeAll();
            rmSync(directory, { recursive: true, force: true });
        }
    }, 20_000);

    it('refuses control up front when the machine has no input backend', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
        const scriptPath = join(directory, 'engine.cjs');
        writeFileSync(
            scriptPath,
            STUB.replaceAll('pointer: true, wheel: true, keyboard: true', 'pointer: false, wheel: false, keyboard: false'),
        );
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, join(directory, 'received.jsonl')] }, PORTAL_HOST);
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
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

        const opened = await desktop.open({ permissions: ['view'] });
        // The engine dies right after it answers. The session record must survive
        // the exit so the client can be told the desktop is gone.
        await new Promise((resolve) => setTimeout(resolve, 400));

        const polled = await desktop.poll(opened.desktopId, 0);
        expect(polled.events).toContainEqual({ kind: 'revoked', reason: 'the desktop engine stopped' });
        await desktop.closeAll();
    }, 20_000);

    it('allows control on an X11 host that has no uinput access, configured or found on its own', async () => {
        const directory = mkdtempSync(join(process.cwd(), 'x-'));
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
                const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, environment);
                hosts.push(desktop);
                expect(await desktop.capabilities()).toMatchObject({ available: true, input: true });
                const opened = await desktop.open({ permissions: ['view', 'control'] });
                expect(opened.geometry.encoded).toEqual({ width: 1280, height: 720 });
                await desktop.closeAll();
                const sent = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
                expect(sent.find((request) => request.method === 'session.open')?.params).toMatchObject({
                    source: environment.DISPLAY === undefined ? { kind: 'x11' } : { kind: 'x11', display: ':77' },
                    permissions: ['view', 'control'],
                });
            }

            writeFileSync(join(runtime, 'wayland-1'), '');
            const environment = { DISPLAY: ':0', XDG_RUNTIME_DIR: runtime };
            const stale = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, environment);
            hosts.push(stale);
            expect(await stale.capabilities()).toMatchObject({ available: true, input: true });
            await stale.open({ permissions: ['view', 'control'] });
            const sent = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
            expect(sent.filter((request) => request.method === 'session.open').at(-1)?.params).toMatchObject({ source: { kind: 'x11', display: ':0' } });

            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject);
                socket.listen(join(runtime, 'wayland-2'), resolve);
            });
            const wayland = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, environment);
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
        const directory = mkdtempSync(join(process.cwd(), 'x-'));
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
            const foreign = new DesktopSessions(options, { XDG_RUNTIME_DIR: directory }, directory);
            hosts.push(foreign);
            expect(await foreign.capabilities()).toMatchObject({ available: true, input: false });
            // Another account's display is not this host's screen, and there is nothing else to show.
            await expect(foreign.open({ permissions: ['view'] })).rejects.toMatchObject({ code: 'no-screen' });

            const explicit = new DesktopSessions(options, { DISPLAY: ':88' }, directory);
            hosts.push(explicit);
            expect(await explicit.capabilities()).toMatchObject({ available: true, input: true });
            await explicit.open({ permissions: ['view', 'control'] });
            const configured = new DesktopSessions(options, { MUXR_DESKTOP_SOURCE: 'x11', MUXR_DESKTOP_X11_DISPLAY: ':99' }, directory);
            hosts.push(configured);
            await configured.open({ permissions: ['view'] });

            hostUid.mockReturnValue(uid);
            const owned = new DesktopSessions(options, { XDG_RUNTIME_DIR: directory }, directory);
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
        const directory = mkdtempSync(join(process.cwd(), 'x-'));
        const socket = createServer();
        const script = join(directory, 'engine.cjs');
        const log = join(directory, 'received.jsonl');
        writeFileSync(script, STUB.replaceAll('pointer: true, wheel: true, keyboard: true', 'pointer: false, wheel: false, keyboard: false'));
        writeFileSync(log, '');
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [script, log] }, { XDG_RUNTIME_DIR: directory }, directory);
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
            const bare = new DesktopSessions({ enginePath: process.execPath, engineArguments: [script, log] }, server, sockets);
            await expect(bare.open({ permissions: ['view', 'control'] })).rejects.toMatchObject({ code: 'no-screen' });
            expect(opened()).toEqual([]);

            const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [script, log] }, { ...server, PATH: `${bin}:${server.PATH}` }, sockets);
            await desktop.open({ permissions: ['view', 'control'] });
            await desktop.closeAll();
            // Killed outright, as a reboot or a crash would: the next open starts it again.
            process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 'SIGKILL');
            await vi.waitFor(() => expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow());
            await desktop.open({ permissions: ['view', 'control'] });
            await desktop.closeAll();
            expect(opened()).toEqual([{ kind: 'x11', display: ':90' }, { kind: 'x11', display: ':90' }]);
            expect(readFileSync(join(directory, 'starts'), 'utf8')).toBe('90\n90\n');

            desktop.stopVirtualDisplay();
            await vi.waitFor(() => expect(existsSync(join(sockets, 'X90'))).toBe(false));
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
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

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
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

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
        await desktop.closeConnection('connection-1');
        await expect(opening).rejects.toMatchObject({ code: 'session' });
        expect(stub.sent().map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }))
            .toContainEqual(expect.objectContaining({ method: 'session.close', params: { session_id: 'engine-session-1' } }));
        connected = true;
        const opened = await desktop.open({ permissions: ['view'] }, {
            connectionId: 'connection-2', isConnected: () => connected,
        });
        connected = false;
        await desktop.closeConnection('connection-2');
        await expect(desktop.poll(opened.desktopId, 0)).rejects.toMatchObject({ code: 'session' });
        expect(stub.sent().filter((line) => JSON.parse(line).method === 'session.close')).toHaveLength(2);
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
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

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
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, log] }, PORTAL_HOST);

        expect(await desktop.capabilities()).toMatchObject({ available: false });

        const sent = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string });
        expect(sent.map((request) => request.method)).toContain('shutdown');
        await desktop.closeAll();
    }, 20_000);
});
