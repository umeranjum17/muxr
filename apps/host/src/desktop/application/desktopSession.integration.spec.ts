import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
        protocol: 1, engine: 'stub/0', platform: 'linux', session: { kind: 'wayland' },
        capture: { mechanism: 'stub', formats: [], cursor: 'embedded', audio: false },
        encode: { codecs: ['vp9'], hardware: false },
        input: { mechanism: 'stub', pointer: true, wheel: true, keyboard: true, text: ['latin1'], unavailable_reason: null, grant: 'granted' },
        clipboard: { read: true, write: true, mime: [], maxBytes: 1024 },
      } });
    case 'capabilities':
      return out({ id: request.id, result: {
        protocol: 1, engine: 'stub/0', platform: 'linux', session: { kind: 'wayland' },
        capture: { mechanism: 'stub', formats: [], cursor: 'embedded', audio: false },
        encode: { codecs: ['vp9'], hardware: false },
        input: { mechanism: 'stub', pointer: true, wheel: true, keyboard: true, text: ['latin1'], unavailable_reason: null, grant: 'granted' },
        clipboard: { read: true, write: true, mime: [], maxBytes: 1024 },
      } });
    case 'session.open':
      setTimeout(() => out({ event: 'session.description', params: { generation: 1, description: { type: 'offer', sdp: 'v=0 offer' } } }), 5);
      setTimeout(() => out({ event: 'session.candidate', params: { generation: 1, candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } }), 10);
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
function sessionsFor(stub: { path: string; log: string }): DesktopSessions {
    return new DesktopSessions({
        enginePath: process.execPath,
        engineArguments: [stub.path, stub.log],
    });
}

describe('desktop sessions, host side', () => {
    it('reports capabilities, opens a session, returns its notifications and closes it', async () => {
        const stub = stubEngine();
        const desktop = sessionsFor(stub);

        const capabilities = await desktop.capabilities();
        expect(capabilities).toMatchObject({ available: true, input: true, clipboard: true, codec: 'vp9' });

        const opened = await desktop.open({ permissions: ['view', 'control', 'clipboard'] });
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
        ]);
        expect(sent[2]?.params).toMatchObject({ permissions: ['view', 'control', 'clipboard'] });
        // The answer and candidate carry the engine's own session id, never the
        // host's opaque handle.
        expect(sent[3]?.params).toMatchObject({ session_id: 'engine-session-1', description: { type: 'answer', sdp: 'v=0 answer' } });
        expect(sent[4]?.params).toMatchObject({ session_id: 'engine-session-1', candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 });
    }, 20_000);

    it('refuses control up front when the machine has no input backend', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'desklink-stub-'));
        const scriptPath = join(directory, 'engine.cjs');
        writeFileSync(
            scriptPath,
            STUB.replaceAll('pointer: true, wheel: true, keyboard: true', 'pointer: false, wheel: false, keyboard: false'),
        );
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [scriptPath, join(directory, 'received.jsonl')] });
        writeFileSync(join(directory, 'received.jsonl'), '');

        const capabilities = await desktop.capabilities();
        expect(capabilities).toMatchObject({ available: true, input: false });

        // The user must be told the desktop is view-only, not handed controls
        // that would silently do nothing.
        await expect(desktop.open({ permissions: ['view', 'control'] })).rejects.toMatchObject({ code: 'input-unavailable' });
        await desktop.closeAll();
    }, 20_000);
});
