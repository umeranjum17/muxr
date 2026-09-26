/**
 * Terminal over the byokit link, against a real relay and a real host-side
 * pane machinery: the stream open IS the attach, herdr's NDJSON flows both
 * ways, and a dropped link reattaches the same pane over the relay channel
 * with a full repaint. The fake herdr bin plays the pane; everything between
 * the phone-shaped DeviceLink and the pane is the real code.
 *
 * Owns the relay it starts: in-process, port 0, real port from the handle.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceLink, hostId, keyPairFrom, type DeviceGrant, type LinkStatus } from '@byokit/link';
import { decodePayload, encodePayload, parseClientFrame, terminalSocketUrl, type ClientFrame, type Envelope, type HostFrame } from '@muxr/contract';
import { generateKeyPair } from '@muxr/crypto';
import { startRelay, type RelayHandle } from '@muxr/relay';
import { TerminalManager, closeTerminal, openTerminal } from '../../agent/index.js';
import { LinkEndpoint, type LinkAnswer } from './linkEndpoint.js';
import type { MachineCryptoState } from '../domain/crypto.js';

/** @muxr/crypto keys are base64 strings; byokit wants base64url bytes. */
const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64');
const toB64url = (valueBase64: string): string => Buffer.from(valueBase64, 'base64').toString('base64url');

/** The pane: paints a full screen, echoes input, repaints on resize. */
function writeFakeHerdr(dir: string): string {
    const bin = join(dir, 'fake-herdr.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const pane = args[3];
const option = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : Number(args[i + 1]); };
let cols = option('--cols');
let rows = option('--rows');
const b64 = (s) => Buffer.from(s).toString('base64');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
send({ type: 'terminal.frame', full: true, bytes: b64(\`SCREEN \${pane} \${cols}x\${rows}\`) });
let buffer = '';
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
        } else if (frame.type === 'terminal.release') {
            process.exit(0);
        }
    }
});
`, { mode: 0o755 });
    return bin;
}

function once<T>(target: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
        target,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
    ]);
}

describe('terminal over the byokit link (real relay + real host)', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) cleanups.pop()!();
    });

    it('attaches, types and resizes over a link stream, then falls back to the relay after a link drop', { timeout: 60_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-link-terminal-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const herdrBin = writeFakeHerdr(dir);

        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay'), developmentApi: true } });
        cleanups.push(() => void relay.close());
        const relayUrl = `ws://127.0.0.1:${relay.port}/relay`;
        const ownerToken = JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string;

        const machine = generateKeyPair();
        const phone = generateKeyPair();
        const crypto: MachineCryptoState = {
            signingPublicKey: b64(new Uint8Array(32)),
            signingSecretKey: b64(new Uint8Array(64)),
            boxPublicKey: machine.publicKey,
            boxSecretKey: machine.secretKey,
            dataKey: b64(new Uint8Array(32)),
            keyVersion: 1,
            devices: [{
                deviceId: 'dev-phone',
                devicePublicKey: phone.publicKey,
                ingressKey: 'ingress',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                authority: 'control',
            }],
        };

        const terminals = new TerminalManager({
            relayUrl,
            machineId: 'machine-test',
            resolvePane: async (sessionId) => `pane-${sessionId}`,
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            herdrBin,
        });
        cleanups.push(() => terminals.closeAll());

        // The same reply surface main.ts wires: attach and detach through the
        // real use cases, so the relay leg runs the unmodified relay path.
        const answer: LinkAnswer = async (frame, deviceId) => {
            if (frame.type === 'terminal.attach') {
                const result = await openTerminal(terminals, frame.params);
                if (result.ok) return { type: 'result', requestId: frame.requestId, ok: true, data: result.data };
                if (result.code === undefined) return { type: 'result', requestId: frame.requestId, ok: false, error: result.error };
                return { type: 'result', requestId: frame.requestId, ok: false, error: result.error, code: result.code };
            }
            if (frame.type === 'terminal.detach') {
                await closeTerminal(terminals, { channel: frame.params.channel, deviceId });
                return { type: 'result', requestId: frame.requestId, ok: true, data: null };
            }
            return undefined;
        };
        const endpoint = await LinkEndpoint.open({
            relayUrl,
            ownerToken,
            machineName: 'test machine',
            crypto,
            currentCrypto: () => crypto,
            answer,
            canView: () => false,
            terminals: { attach: (params) => terminals.attach(params) },
        });
        expect(endpoint).toBeDefined();
        cleanups.push(() => endpoint!.close());

        // The host serves the relay transport too, like main.ts wires it: a
        // machine peer whose client frames go through `answer`.
        const machineFrames = new WebSocket(`${relayUrl}?role=machine&machineId=machine-test`);
        await once(new Promise<void>((resolve, reject) => {
            machineFrames.once('open', resolve);
            machineFrames.once('error', reject);
        }), 5_000, 'machine socket');
        let machineSeq = 0;
        const pendingRelayResults = new Map<string, (frame: HostFrame) => void>();
        machineFrames.on('message', (data) => {
            const envelope = JSON.parse(String(data)) as Envelope;
            // relay.* control frames carry no payload envelope.
            if (envelope?.header === undefined || typeof envelope.payload !== 'string') return;
            const frame = decodePayload<HostFrame | ClientFrame>(envelope.payload);
            if (frame.type === 'result') {
                const settled = pendingRelayResults.get(frame.requestId);
                if (settled !== undefined) { pendingRelayResults.delete(frame.requestId); settled(frame); }
                return;
            }
            void (async () => {
                const response = await answer(frame as ClientFrame, 'dev-phone');
                if (response === undefined) return;
                machineSeq += 1;
                machineFrames.send(JSON.stringify({
                    header: { machineId: 'machine-test', seq: machineSeq, at: Date.now() },
                    payload: encodePayload(response),
                }));
            })();
        });

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
        const attachAck = await once(nextFrame(), 10_000, 'link attach ack');
        const linkAttachMs = Date.now() - linkAttachStarted;        expect(attachAck).toMatchObject({ type: 'result', ok: true, data: { paneId: 'pane-s1' } });

        // Frame bytes the pane painted, skipping anything else (scroll-state,
        // the initial screen still in the buffer).
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

        // The pane's initial full repaint rides the same stream (herdr paints
        // the whole screen on attach), followed by its scroll state.
        expect(await nextFrameBytes('initial paint')).toBe('SCREEN pane-s1 20x5');

        // Typing.
        const typed = 'hello over the link';
        await stream.write(`${JSON.stringify({ type: 'terminal.input', text: typed })}\n`);
        expect(await nextFrameBytes('echo')).toBe(typed);

        // Resize.
        await stream.write(`${JSON.stringify({ type: 'terminal.resize', cols: 40, rows: 12 })}\n`);
        expect(await nextFrameBytes('resize repaint')).toBe('SCREEN pane-s1 40x12');

        // ---- The link drops mid-session; the pane reattaches over the relay. ----
        link.stop(); // the drop: the host sees the stream end and retires the pane pipe
        // The phone's session socket, as MuxrClient dials it in cleartext mode.
        const sessionClient = new WebSocket(`${relayUrl}?role=client&machineId=machine-test`);
        cleanups.push(() => sessionClient.close());
        await once(new Promise<void>((resolve, reject) => {
            sessionClient.once('open', resolve);
            sessionClient.once('error', reject);
        }), 5_000, 'session socket');
        // Request results come back on the session socket, as the phone reads them.
        sessionClient.on('message', (data) => {
            const envelope = JSON.parse(String(data)) as Envelope;
            if (envelope?.header === undefined || typeof envelope.payload !== 'string') return;
            const frame = decodePayload<HostFrame | ClientFrame>(envelope.payload);
            if (frame.type === 'result') {
                const settled = pendingRelayResults.get(frame.requestId);
                if (settled !== undefined) { pendingRelayResults.delete(frame.requestId); settled(frame); }
            }
        });
        const sendFromClient = (frame: ClientFrame): void => {
            sessionClient.send(JSON.stringify({
                header: { machineId: 'machine-test', seq: Date.now(), at: Date.now() },
                payload: encodePayload(frame),
            }));
        };
        const relayChannel = 'tm_test_2';
        const relayAttachStarted = Date.now();
        const relayResult = new Promise<HostFrame>((resolve) => pendingRelayResults.set('r-attach', resolve));
        sendFromClient({ type: 'terminal.attach', requestId: 'r-attach', params: { sessionId: 's1', channel: relayChannel, cols: 20, rows: 5, takeover: true, deviceId: 'dev-phone' } });
        const attachReply = await once(relayResult, 10_000, 'relay attach');
        const relayAttachMs = Date.now() - relayAttachStarted;
        expect(attachReply).toMatchObject({ type: 'result', ok: true, data: { paneId: 'pane-s1' } });

        const clientChannel = new WebSocket(terminalSocketUrl(relayUrl, { machineId: 'machine-test', channel: relayChannel, role: 'client' }));
        await once(new Promise<void>((resolve, reject) => {
            clientChannel.once('open', resolve);
            clientChannel.once('error', reject);
        }), 5_000, 'terminal channel');
        const channelLines: string[] = [];
        const nextLine = (): Promise<string> => new Promise((resolve) => {
            const check = (): void => { if (channelLines.length > 0) resolve(channelLines.shift()!); };
            check();
            lineWaiters.push(check);
        });
        const lineWaiters: Array<() => void> = [];
        clientChannel.on('message', (data) => {
            channelLines.push(String(data));
            for (const check of lineWaiters.splice(0)) check();
        });
        // The reattach repaints the whole screen: the pane was never lost.
        const repaint = JSON.parse(await once(nextLine(), 5_000, 'repaint')) as { type: string; bytes?: string };
        expect(repaint).toMatchObject({ type: 'terminal.frame', bytes: b64(Buffer.from('SCREEN pane-s1 20x5')) });

        clientChannel.send(JSON.stringify({ type: 'terminal.input', text: 'typed over relay' }));
        expect(await once(nextLine(), 5_000, 'relay echo')).toBe(JSON.stringify({ type: 'terminal.frame', bytes: b64(Buffer.from('typed over relay')) }));

        // Detach rides the session requests, as the phone's close() sends it.
        sendFromClient({ type: 'terminal.detach', requestId: 'r-detach', params: { sessionId: 's1', channel: relayChannel } });
        await once(new Promise<void>((resolve) => clientChannel.once('close', resolve)), 5_000, 'channel close');

        // The before/after number for the connect-time budget. Both legs
        // include the herdr spawn, so they are directly comparable.
        process.stdout.write(`terminal attach: link=${linkAttachMs}ms relay=${relayAttachMs}ms\n`);
        expect(linkAttachMs).toBeLessThan(5_000);
        expect(relayAttachMs).toBeLessThan(5_000);

        // The wire frames the relay carried are the same NDJSON the link did.
        expect(parseClientFrame({ type: 'terminal.attach', requestId: 'x', params: {} }).type).toBe('terminal.attach');

        link.stop();
        machineFrames.close();
        clientChannel.close();
    });
});
