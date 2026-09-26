/**
 * Terminal over the byokit link, against a real relay and a real host-side
 * pane machinery: the stream open IS the attach, herdr's NDJSON flows both
 * ways, and the pane's only transport is the link. The fake herdr bin plays
 * the pane; everything between the phone-shaped DeviceLink and the pane is
 * the real code.
 *
 * One-shot rule: there is no relay fallback in this flow. A dropped link
 * ends the stream; the pane reattaches when the link is back.
 *
 * Owns the relay it starts: in-process, port 0, real port from the handle.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceLink, hostId, keyPairFrom, type DeviceGrant, type LinkStatus } from '@byokit/link';
import { terminalSocketUrl, type Envelope, type HostFrame } from '@muxr/contract';
import { generateKeyPair, generateSigningKeyPair } from '@muxr/crypto';
import { startRelay } from '@muxr/relay';
import { TerminalManager, closeTerminal } from '../../agent/index.js';
import { LinkEndpoint, type LinkAnswer } from './linkEndpoint.js';
import type { MachineCryptoState } from '../domain/crypto.js';

const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64');
/** @muxr/crypto keys are base64 strings; byokit wants base64url bytes. */
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

    it('attaches, types and resizes over a link stream; the link is the pane\u2019s only transport', { timeout: 60_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-link-terminal-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const herdrBin = writeFakeHerdr(dir);

        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay'), developmentApi: true } });
        cleanups.push(() => void relay.close());
        const relayUrl = `ws://127.0.0.1:${relay.port}/relay`;
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

        const terminals = new TerminalManager({
            resolvePane: async (sessionId) => `pane-${sessionId}`,
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            herdrBin,
        });
        cleanups.push(() => terminals.closeAll());

        // Detach rides the session requests, as the phone's close() sends it.
        const answer: LinkAnswer = async (frame, deviceId) => {
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
            savePushLevel: () => undefined,
            grants: { load: () => [], save: () => undefined },
            answer,
            canView: () => false,
            terminals: {
                attach: (params) => {
                    params.assertAuthorized();
                    return terminals.attach(params);
                },
                sendResult: (socket, channel, result) => socket.send(JSON.stringify({ ...result, channel })),
            },
        });
        expect(endpoint).toBeDefined();
        endpoint!.start(); // dials the relay on the byokit link route
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
        const attachAck = await once(nextFrame(), 10_000, 'link attach ack');
        const linkAttachMs = Date.now() - linkAttachStarted;
        expect(attachAck).toMatchObject({ type: 'result', ok: true, data: { paneId: 'pane-s1' } });

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

        // ---- Detach rides the session requests, as the phone's close() sends
        // it: the host retires the pane and ends the stream. ----
        await link.request('terminal.detach', { type: 'terminal.detach', requestId: 'r-detach', params: { sessionId: 's1', channel } });
        await once(new Promise<void>((resolve) => {
            const check = setInterval(() => { if (ended) { clearInterval(check); resolve(); } }, 25);
        }), 5_000, 'detach stream end');

        // The connect-time budget: the attach includes the herdr spawn.
        process.stdout.write(`terminal attach: link=${linkAttachMs}ms\n`);
        expect(linkAttachMs).toBeLessThan(5_000);

        link.stop();
    });
});
