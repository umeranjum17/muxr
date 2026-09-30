/**
 * Terminal and realtime voice over the byokit link, against a real relay and
 * host-side stream machinery. The fake herdr bin plays the pane; everything
 * between the phone-shaped DeviceLink and the pane is the real code.
 *
 * Owns the relay it starts: in-process, port 0, real port from the handle.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HerdrKit } from '@byokit/herdr';
import { DeviceLink, hostId, keyPairFrom, type DeviceGrant, type LinkStatus } from '@byokit/link';
import type { HostFrame } from '@trymuxr/contract';
import { generateKeyPair, generateSigningKeyPair } from '@trymuxr/crypto';
import { startRelay } from '@muxr/relay';
import { VoiceStreamManager, TerminalManager, type VoiceStreamTransport } from '../../agent/index.js';
import { LinkEndpoint } from './linkEndpoint.js';
import type { MachineCryptoState } from '../domain/crypto.js';

const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64');
/** @trymuxr/crypto keys are base64 strings; byokit wants base64url bytes. */
const toB64url = (valueBase64: string): string => Buffer.from(valueBase64, 'base64').toString('base64url');

/**
 * The pane: paints a full screen, echoes input, repaints on resize, and scrolls
 * like a full-screen program -- it repaints on a wheel report only while there
 * is transcript left that way (100 rows), and logs every report it is handed.
 */
function writeFakeHerdr(dir: string, ownsScroll = false): string {
    const bin = join(dir, 'fake-herdr.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const pane = args[3];
const option = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : Number(args[i + 1]); };
let cols = option('--cols');
let rows = option('--rows');
const b64 = (s) => Buffer.from(s).toString('base64');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
send({ type: 'terminal.frame', full: true, bytes: b64(\`SCREEN \${pane} \${cols}x\${rows}\`) });
let buffer = '';
let back = 0;
const scrollFile = ${JSON.stringify(join(dir, 'scroll.json'))};
const ownsScroll = ${ownsScroll};
const wheelLog = ${JSON.stringify(join(dir, 'wheel.log'))};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\\n'); nl >= 0; nl = buffer.indexOf('\\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === 'terminal.input' && typeof frame.text === 'string') {
            send({ type: 'terminal.frame', bytes: b64(frame.text) });
        } else if (frame.type === 'terminal.resize') {
            cols = frame.cols;
            rows = frame.rows;
            send({ type: 'terminal.frame', bytes: b64(\`SCREEN \${pane} \${cols}x\${rows}\`) });
        } else if (frame.type === 'terminal.scroll') {
            appendFileSync(wheelLog, frame.direction + ' ' + Date.now() + '\\n');
            if (ownsScroll) {
                const state = JSON.parse(readFileSync(scrollFile, 'utf8'));
                state.offsetFromBottom += state.burst;
                state.burst = 0;
                state.offsetFromBottom = Math.max(0, state.offsetFromBottom - frame.lines);
                writeFileSync(scrollFile, JSON.stringify(state));
                send({ type: 'terminal.frame', bytes: b64('OFFSET ' + state.offsetFromBottom) });
                continue;
            }
            const moved = frame.direction === 'up' ? Math.min(100, back + frame.lines) : Math.max(0, back - frame.lines);
            if (moved === back) continue;
            back = moved;
            send({ type: 'terminal.frame', bytes: b64(\`SCROLL \${frame.direction} \${frame.lines}\`) });
        } else if (frame.type === 'terminal.release') {
            process.exit(0);
        }
    }
});
`, { mode: 0o755 });
    return bin;
}

/** Kit-backed terminal opener over a stub herdr bin. The K6 `path` entry is
 * what lets the `#!/usr/bin/env node` stub resolve node; without it the kit's
 * fixed adopt PATH cannot spawn the stub. */
function openTerminalFor(bin: string) {
    const kit = new HerdrKit({
        mode: 'adopt',
        bin,
        socketPath: join(tmpdir(), 'muxr-terminal-test-unused.sock'),
        path: [dirname(process.execPath)],
    });
    return (paneId: string, opts: { mode: 'control' | 'observe'; cols: number; rows: number }) =>
        kit.terminal(paneId, opts);
}

function once<T>(target: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
        target,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
    ]);
}

describe('byokit link streams (real relay + real host)', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) cleanups.pop()!();
    });

    it('holds a streaming pane at a slow phone instead of queueing its whole output', { timeout: 15_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-terminal-pressure-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const bin = join(dir, 'stream.mjs');
        writeFileSync(bin, `#!/usr/bin/env node
for (let i = 0; i < 200; i++) process.stdout.write(JSON.stringify({ type: 'terminal.frame', full: i === 0, bytes: 'a'.repeat(4096) }) + '\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            openTerminal: openTerminalFor(bin),
        });
        cleanups.push(() => manager.closeAll());
        let sent = 0;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        cleanups.push(release);
        const socket = {
            isOpen: true,
            send: () => { sent++; return blocked; },
            onLine: () => () => undefined,
            onEnd: () => () => undefined,
            close: () => undefined,
        };
        await manager.attach({ sessionId: 's1', channel: 'slow', cols: 20, rows: 5, socket });
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => { if (sent > 0) { clearInterval(timer); resolve(); } }, 10);
        }), 3000, 'first frame');
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(sent).toBe(1);
        release();
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => { if (sent === 200) { clearInterval(timer); resolve(); } }, 10);
        }), 3000, 'stream resume');
        expect(sent).toBe(200);
    });

    it('finishes Latest against the pane after output outruns the phone offset', { timeout: 10_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-terminal-bottom-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const scrollFile = join(dir, 'scroll.json');
        writeFileSync(scrollFile, JSON.stringify({ offsetFromBottom: 100, maxOffsetFromBottom: 5_000, burst: 2_500 }));
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            readPaneScroll: async () => JSON.parse(readFileSync(scrollFile, 'utf8')),
            openTerminal: openTerminalFor(writeFakeHerdr(dir, true)),
        });
        cleanups.push(() => manager.closeAll());
        let input!: (line: string) => void;
        const results: Array<{ type: string; state?: string }> = [];
        const socket = {
            isOpen: true,
            send: (line: string) => { results.push(JSON.parse(line)); },
            onLine: (listener: (line: string) => void) => { input = listener; return () => undefined; },
            onEnd: () => () => undefined,
            close: () => undefined,
        };
        await manager.attach({ sessionId: 's1', channel: 'bottom', cols: 20, rows: 5, socket });
        input(JSON.stringify({ type: 'terminal.bottom', requestId: 'burst-bottom' }));
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => {
                if (results.some((frame) => frame.type === 'terminal.bottom-state' && frame.state === 'complete')) {
                    clearInterval(timer);
                    resolve();
                }
            }, 10);
            cleanups.push(() => clearInterval(timer));
        }), 4_000, 'Latest completion');
        expect(JSON.parse(readFileSync(scrollFile, 'utf8')).offsetFromBottom).toBe(0);
        expect(results).toContainEqual({ type: 'terminal.bottom-state', requestId: 'burst-bottom', state: 'catching-up' });
        expect(results).toContainEqual({ type: 'terminal.bottom-state', requestId: 'burst-bottom', state: 'complete' });
        expect(readFileSync(join(dir, 'wheel.log'), 'utf8').trim().split('\n')).toHaveLength(2);
    });

    it('carries terminal and voice streams over the byokit link', { timeout: 60_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-link-terminal-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const herdrBin = writeFakeHerdr(dir);
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay') } });
        cleanups.push(() => void relay.close());
        const relayUrl = `ws://127.0.0.1:${relay.port}/relay`;
        const base = `http://127.0.0.1:${relay.port}`;
        const health = await (await fetch(`${base}/health`)).json() as { muxrVersion: string; linkProtocol: number };
        expect(health.linkProtocol).toBe(1);
        expect(health.muxrVersion).toMatch(/^\d+\.\d+\.\d+/);
        const oldGrant = await fetch(`${base}/v1/machines/old/grant`);
        expect(oldGrant.status).toBe(410);
        expect((await oldGrant.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('Update the muxr app') });
        const oldTicket = await fetch(`${base}/v1/ws-tickets`, { method: 'POST' });
        expect(oldTicket.status).toBe(403); // 0.2.0 maps this to its fixed re-pair message.
        const ownerToken = JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string;

        const machine = generateKeyPair();
        const machineSigning = generateSigningKeyPair();
        const phone = generateKeyPair();
        const crypto: MachineCryptoState = {
            signingPublicKey: machineSigning.publicKey,
            signingSecretKey: machineSigning.secretKey,
            boxPublicKey: machine.publicKey,
            boxSecretKey: machine.secretKey,
            dataKey: b64(new Uint8Array(32)),
            keyVersion: 1,
            devices: [{
                deviceId: 'dev-phone',
                kind: 'browser',
                devicePublicKey: phone.publicKey,
                ingressKey: 'ingress',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                authority: 'control',
            }],
        };

        const voiceRoot = join(dir, 'voice-plugin');
        const voiceEntry = join(voiceRoot, 'stream.mjs');
        mkdirSync(voiceRoot, { recursive: true });
        writeFileSync(voiceEntry, `import readline from 'node:readline';\nconst input = readline.createInterface({ input: process.stdin });\ninput.on('line', (line) => { const frame = JSON.parse(line); if (frame.type === 'realtime.audio') process.stdout.write(JSON.stringify({ type: 'realtime.transcript', role: 'user', text: 'voice frame received' }) + '\\n'); });\n`);
        const voiceRuntime = new VoiceStreamManager({});
        cleanups.push(() => voiceRuntime.closeAll());

        const terminals = new TerminalManager({
            resolvePane: async (sessionId) => `pane-${sessionId}`,
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            openTerminal: openTerminalFor(herdrBin),
        });
        cleanups.push(() => terminals.closeAll());

        const endpoint = await LinkEndpoint.open({
            relayUrl,
            ownerToken,
            machineName: 'test machine',
            crypto,
            currentCrypto: () => crypto,
            savePushLevel: () => undefined,
            grants: { load: () => [], save: () => undefined },
            answer: async () => undefined,
            canView: () => false,
            terminals: {
                attach: (params) => terminals.attach(params),
                sendResult: (socket, channel, result) => terminals.sendResult(socket, channel, result),
            },
            voiceStreams: {
                attach: ({ deviceId, channel, sessionId, stream }) => voiceRuntime.attach({
                    target: { providerId: 'voice-test', runtimeRoot: voiceRoot, entry: 'stream.mjs' },
                    channel,
                    stateDir: join(dir, 'voice-state'),
                    ...(sessionId === undefined ? {} : { sessionId }),
                    deviceId,
                    transport: {
                        set onData(listener: VoiceStreamTransport['onData']) { stream.onData = listener; },
                        set onEnd(listener: VoiceStreamTransport['onEnd']) { stream.onEnd = listener; },
                        write: (chunk) => stream.write(chunk),
                        end: (error) => stream.end(error),
                    },
                    signal: new AbortController().signal,
                    onClosed: () => undefined,
                }),
            },
        });
        expect(endpoint).toBeDefined();
        endpoint!.start();
        cleanups.push(() => endpoint!.close());

        const machineKeys = keyPairFrom(Buffer.from(machine.secretKey, 'base64'));
        const phoneGrant: DeviceGrant = {
            v: 1,
            secretKey: toB64url(phone.secretKey),
            host: toB64url(machine.publicKey),
            hostName: 'test machine',
            urls: [`ws://127.0.0.1:${relay.port}/link/v1/${hostId(machineKeys.publicKey)}`],
            device: { id: '', name: 'Test phone', role: 'control' },
        };
        const statuses: LinkStatus[] = [];
        const link = new DeviceLink(phoneGrant, { onStatus: (s) => statuses.push(s) });
        cleanups.push(() => link.stop());
        await once(new Promise<void>((resolve, reject) => {
            const timer = setInterval(() => {
                if (link.status === 'online') { clearInterval(timer); resolve(); }
                if (statuses.includes('refused') || statuses.includes('removed')) { clearInterval(timer); reject(new Error(`link refused: ${statuses.join(',')}`)); }
            }, 50);
            setTimeout(() => { clearInterval(timer); reject(new Error(`link never came online: ${statuses.join(',')}`)); }, 15_000);
        }), 16_000, 'link online');

        // ---- Attach over the link: the stream open IS the attach. ----
        const channel = 'tm_test_1';
        const linkAttachStarted = Date.now();
        const stream = await link.stream('terminal', {
            requestId: 'lt-1',
            sessionId: 's1',
            channel,
            cols: 20,
            rows: 5,
            takeover: true,
        });
        let buffer = '';
        let ended = false;
        const pending: Array<{ resolve: (f: HostFrame) => void; reject: (e: Error) => void }> = [];
        const pump = (): void => {
            // Lines wait in the buffer until someone awaits them; nothing is dropped.
            while (pending.length > 0) {
                const nl = buffer.indexOf('\n');
                if (nl < 0) return;
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (!line.trim()) continue;
                pending.shift()!.resolve(JSON.parse(line) as HostFrame);
            }
        };
        const nextFrame = (): Promise<HostFrame> => new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
            pump(); // may resolve immediately from an already-buffered line
            if (ended) reject(new Error('stream already ended'));
        });
        stream.onData = (chunk) => {
            buffer += Buffer.from(chunk).toString('utf8');
            pump();
        };
        stream.onEnd = (error) => {
            ended = true;
            for (const waiter of pending.splice(0)) waiter.reject(new Error(`stream ended before its frame (error: ${error ?? 'clean'})`));
        };
        let attachAck: HostFrame | undefined;
        let initialPaint: string | undefined;
        let linkAttachMs = 0;
        while (attachAck === undefined || initialPaint === undefined) {
            const frame = await once(nextFrame(), 10_000, 'link attach and initial paint') as HostFrame | { type: 'terminal.frame'; full?: boolean; bytes: string };
            if (frame.type === 'result') {
                attachAck = frame;
                linkAttachMs = Date.now() - linkAttachStarted;
            } else if (frame.type === 'terminal.frame' && frame.full === true) {
                initialPaint = Buffer.from(frame.bytes, 'base64').toString('utf8');
            }
        }
        expect(attachAck).toMatchObject({ type: 'result', ok: true, data: { paneId: 'pane-s1' } });
        expect(initialPaint).toBe('SCREEN pane-s1 20x5');

        // Frame bytes the pane painted, skipping anything else (scroll-state).
        const nextFrameBytes = async (what: string): Promise<string> => {
            const done = once((async () => {
                for (;;) {
                    // Terminal frames are the raw channel protocol, not envelope frames.
                    const frame = await nextFrame() as unknown as { type: string; bytes?: unknown };
                    if (frame.type === 'terminal.frame' && typeof frame.bytes === 'string') {
                        return Buffer.from(frame.bytes, 'base64').toString('utf8');
                    }
                }
            })(), 5_000, what);
            return done;
        };

        // Typing.
        const typed = 'hello over the link';
        await stream.write(`${JSON.stringify({ type: 'terminal.input', text: typed })}\n`);
        expect(await nextFrameBytes('echo')).toBe(typed);

        // Resize.
        await stream.write(`${JSON.stringify({ type: 'terminal.resize', cols: 40, rows: 12 })}\n`);
        expect(await nextFrameBytes('resize repaint')).toBe('SCREEN pane-s1 40x12');

        // A pane with no Herdr scrollback (Claude Code on the alternate
        // screen) gets a 30-row drag as 30 wheel reports. Herdr turns any one
        // scroll into a single report, which is how a fling or a jump to
        // Latest used to move Claude Code by one notch.
        // The host learns that from Herdr's scroll state, read just after the first paint.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await stream.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 30, column: 10, row: 6 })}\n`);
        const reports: string[] = [];
        while (reports.length < 30) reports.push(await nextFrameBytes('wheel report'));
        expect(reports).toEqual(Array.from({ length: 30 }, () => 'SCROLL up 1'));
        const wheelLog = (): Array<[string, number]> => readFileSync(join(dir, 'wheel.log'), 'utf8').split('\n').filter(Boolean)
            .map((line) => { const [direction, at] = line.split(' '); return [direction!, Number(at)]; });
        // ...in bursts of four with a rest after each, so Claude Code does not
        // read them as one fast spin and multiply the drag.
        const drag = wheelLog().map(([, at]) => at);
        for (let i = 4; i < drag.length; i += 4) expect(drag[i]! - drag[i - 4]!).toBeGreaterThanOrEqual(40);

        // Latest reaches past the rows it counted, because output lands below
        // while the phone reads back. The wheel stops where the pane stops
        // repainting instead of turning out the whole reach at the bottom.
        const wheel = (): string[] => wheelLog().map(([direction]) => direction);
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        await stream.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'down', lines: 2_030, column: 10, row: 6 })}\n`);
        const back: string[] = [];
        while (back.length < 30) back.push(await nextFrameBytes('wheel back to the bottom'));
        expect(back).toEqual(Array.from({ length: 30 }, () => 'SCROLL down 1'));
        await sleep(1_500);
        const settled = wheel().length;
        await sleep(500);
        expect(wheel().length).toBe(settled);
        expect(settled).toBeLessThan(1_000);

        // A finger that turns back is followed at once, not after the rows
        // still owed the other way.
        const turnedAt = wheel().length;
        await stream.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 60, column: 10, row: 6 })}\n`);
        expect(await nextFrameBytes('wheel turning up')).toBe('SCROLL up 1');
        await stream.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'down', lines: 5, column: 10, row: 6 })}\n`);
        while (await nextFrameBytes('wheel turned back') !== 'SCROLL down 1') { /* the ups already sent */ }
        await sleep(300);
        const turn = wheel().slice(turnedAt);
        const turnedBack = turn.indexOf('down');
        expect(turnedBack).toBeLessThan(60);
        expect(turn.slice(turnedBack)).toEqual(Array.from({ length: 5 }, () => 'down'));

        // Voice frames traverse the host stream adapter over the byokit link.
        const voice = await link.stream('voice', { channel: 'rs_linkvoice1234', sessionId: 's1' });
        const voiceReply = new Promise<string>((resolve, reject) => {
            let received = '';
            voice.onData = (chunk) => {
                received += Buffer.from(chunk).toString('utf8');
                if (received.includes('\n')) resolve(received.trim());
            };
            voice.onEnd = (error) => reject(new Error(`voice link ended: ${error ?? 'clean'}`));
        });
        const voiceStarted = Date.now();
        const voiceFrame = JSON.stringify({ type: 'realtime.audio', data: 'AQI=' });
        await voice.write(`${voiceFrame}\n`);
        expect(await once(voiceReply, 5_000, 'voice link round trip')).toBe(JSON.stringify({ type: 'realtime.transcript', role: 'user', text: 'voice frame received' }));
        const voiceLinkRttMs = Date.now() - voiceStarted;
        process.stdout.write(`voice link round trip: ${voiceLinkRttMs}ms\n`);
        expect(voiceLinkRttMs).toBeLessThan(5_000);

        // The authenticated link no longer exposes the retired plugin stream
        // operation; a client that still attempts it is rejected by the host.
        await expect(link.stream('plugin' as never, {
            pluginId: 'fixture', manifestHash: 'fixture-hash', contributionId: 'voice', channel: 'rs_plugin_test',
        } as never)).rejects.toThrow(/isn't allowed/i);

        expect(linkAttachMs).toBeLessThan(5_000);

        link.stop();
    });
});
