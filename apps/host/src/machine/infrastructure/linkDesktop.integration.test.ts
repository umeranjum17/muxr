import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceLink, hostId, keyPairFrom, type DeviceGrant, type LinkStatus } from '@byokit/link';
import { decodePayload, encodePayload, type ClientFrame, type Envelope, type HostFrame } from '@muxr/contract';
import { generateKeyPair } from '@muxr/crypto';
import { startRelay } from '@muxr/relay';
import { DesktopSessions } from '../../desktop/index.js';
import { LinkEndpoint, type LinkAnswer } from './linkEndpoint.js';
import type { MachineCryptoState } from '../domain/crypto.js';

const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64');
const toB64url = (value: string): string => Buffer.from(value, 'base64').toString('base64url');
const STUB = `
const readline = require('node:readline');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const caps = { protocol: 2, engine: 'stub/0', platform: 'linux', session: { kind: 'wayland' }, capture: { mechanism: 'stub', formats: [], cursor: 'embedded', audio: false }, encode: { codecs: ['vp9'], hardware: false }, input: { mechanism: 'stub', pointer: true, wheel: true, keyboard: true, text: ['latin1'], unavailable_reason: null, grant: 'granted' }, clipboard: { read: true, write: true, mime: [], maxBytes: 1024 } };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
 const request = JSON.parse(line);
 if (request.method === 'hello' || request.method === 'capabilities') return out({ id: request.id, result: caps });
 if (request.method === 'session.open') {
   out({ event: 'session.description', params: { sessionId: 'engine-session', generation: 1, description: { type: 'offer', sdp: 'v=0 offer' } } });
   return out({ id: request.id, result: { sessionId: 'engine-session', generation: 1, source: { kind: 'monitor', width: 100, height: 100, origin: { x: 0, y: 0 } }, geometry: { source: { width: 100, height: 100 }, encoded: { width: 100, height: 100 }, origin: { x: 0, y: 0 } } } });
 }
 if (request.method === 'session.description' || request.method === 'session.candidate') return out({ id: request.id, result: { accepted: true } });
 if (request.method === 'session.close' || request.method === 'shutdown') return out({ id: request.id, result: { closed: true } });
 out({ id: request.id, error: { code: 'operation', message: 'unknown ' + request.method } });
});
`;

function waitFor<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))]);
}

describe('desktop signaling over the byokit link (real relay + host)', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

    it('opens and signals on a link stream, preserves the WebRTC session on link loss, then uses relay signaling', { timeout: 60_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-link-desktop-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const engine = join(dir, 'desktop-engine.cjs');
        writeFileSync(engine, STUB);
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay'), developmentApi: true, advertiseMdns: false } });
        cleanups.push(() => void relay.close());
        const relayUrl = `ws://127.0.0.1:${relay.port}/relay`;
        const ownerToken = JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string;
        const machine = generateKeyPair();
        const phone = generateKeyPair();
        const deviceId = 'dev-desktop-phone';
        const crypto: MachineCryptoState = {
            signingPublicKey: b64(new Uint8Array(32)), signingSecretKey: b64(new Uint8Array(64)),
            boxPublicKey: machine.publicKey, boxSecretKey: machine.secretKey, dataKey: b64(new Uint8Array(32)), keyVersion: 1,
            devices: [{ deviceId, devicePublicKey: phone.publicKey, ingressKey: 'ingress', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), authority: 'control' }],
        };
        const desktop = new DesktopSessions({ enginePath: process.execPath, engineArguments: [engine] }, { WAYLAND_DISPLAY: 'wayland-0' });
        cleanups.push(() => void desktop.closeAll());
        const active = new Set<string>();
        const answer: LinkAnswer = async (frame, sender, connectionId) => {
            if (frame.type === 'desktop.capabilities') return result(frame, await desktop.capabilities());
            if (frame.type === 'desktop.open') return result(frame, await desktop.open(frame.params, connectionId === undefined ? undefined : {
                connectionId, deviceId: sender, isConnected: () => active.has(connectionId),
            }));
            if (frame.type === 'desktop.answer') return result(frame, await desktop.answer(frame.params.desktopId, frame.params.sdp, connectionId, sender));
            if (frame.type === 'desktop.candidate') return result(frame, await desktop.candidate(frame.params.desktopId, frame.params.candidate, frame.params.sdpMid ?? null, frame.params.sdpMLineIndex ?? null, connectionId, sender));
            if (frame.type === 'desktop.poll') return result(frame, await desktop.poll(frame.params.desktopId, frame.params.cursor, connectionId, sender));
            if (frame.type === 'desktop.close') return result(frame, await desktop.close(frame.params.desktopId, connectionId, sender));
            return undefined;
        };
        const endpoint = await LinkEndpoint.open({
            relayUrl, ownerToken, machineName: 'test machine', crypto, currentCrypto: () => crypto, answer,
            canView: () => false, onDesktopConnection: (id, online) => online ? active.add(id) : active.delete(id),
        });
        expect(endpoint).toBeDefined();
        cleanups.push(() => endpoint!.close());

        const machineSocket = new WebSocket(`${relayUrl}?role=machine&machineId=machine-desktop-test`);
        await waitFor(new Promise<void>((resolve, reject) => { machineSocket.once('open', resolve); machineSocket.once('error', reject); }), 5_000, 'machine relay');
        let machineSeq = 0;
        let relayClient: WebSocket | undefined;
        const relayResults = new Map<string, (frame: HostFrame) => void>();
        machineSocket.on('message', (data) => {
            const envelope = JSON.parse(String(data)) as Envelope;
            if (envelope?.header === undefined || typeof envelope.payload !== 'string') return;
            const frame = decodePayload<HostFrame | ClientFrame>(envelope.payload);
            if (frame.type === 'result') return;
            const connectionId = 'relay:desktop-phone';
            active.add(connectionId);
            void answer(frame as ClientFrame, deviceId, connectionId).then((response) => {
                if (response === undefined || relayClient === undefined) return;
                machineSeq += 1;
                machineSocket.send(JSON.stringify({ header: { machineId: 'machine-desktop-test', seq: machineSeq, at: Date.now() }, payload: encodePayload(response) }));
            });
        });

        const machineKeys = keyPairFrom(Buffer.from(machine.secretKey, 'base64'));
        const grant: DeviceGrant = {
            v: 1, secretKey: toB64url(phone.secretKey), host: toB64url(machine.publicKey), hostName: 'test machine',
            urls: [`ws://127.0.0.1:${relay.port}/link/v1/${hostId(machineKeys.publicKey)}`],
            device: { id: '', name: 'Test phone', role: 'control' },
        };
        const statuses: LinkStatus[] = [];
        const link = new DeviceLink(grant, { onStatus: (status) => statuses.push(status) });
        cleanups.push(() => link.stop());
        await waitFor(new Promise<void>((resolve, reject) => {
            const timer = setInterval(() => {
                if (link.status === 'online') { clearInterval(timer); resolve(); }
                if (statuses.includes('refused') || statuses.includes('removed')) { clearInterval(timer); reject(new Error(`link refused: ${statuses.join(',')}`)); }
            }, 50);
        }), 15_000, 'link online');

        const stream = await link.stream('desktop', {});
        let buffer = '';
        const lines: HostFrame[] = [];
        const waiters: Array<(frame: HostFrame) => void> = [];
        stream.onData = (chunk) => {
            buffer += Buffer.from(chunk).toString('utf8');
            for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
                const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
                const waiter = waiters.shift();
                if (waiter !== undefined) waiter(JSON.parse(line) as HostFrame); else lines.push(JSON.parse(line) as HostFrame);
            }
        };
        const next = (): Promise<HostFrame> => new Promise((resolve) => { const frame = lines.shift(); if (frame) resolve(frame); else waiters.push(resolve); });
        let requestNo = 0;
        const linkRequest = async (frame: ClientFrame): Promise<HostFrame> => {
            if (!('requestId' in frame)) throw new Error('desktop request needs a request id');
            requestNo += 1;
            const answer = next();
            await stream.write(`${JSON.stringify(frame)}\n`);
            return waitFor(answer, 10_000, frame.type);
        };
        const started = Date.now();
        const openedLink = await linkRequest({ type: 'desktop.open', requestId: `link-desktop-${++requestNo}`, params: { permissions: ['view'], maxWidth: 640, maxHeight: 480 } });
        expect(openedLink).toMatchObject({ type: 'result', ok: true });
        const linkDesktopId = responseData<{ desktopId: string }>(openedLink);
        await expect(desktop.poll(linkDesktopId.desktopId, 0, 'relay:other')).rejects.toMatchObject({ code: 'session' });
        await expect(desktop.close(linkDesktopId.desktopId, 'relay:other')).rejects.toMatchObject({ code: 'session' });
        const firstLink = await linkRequest({ type: 'desktop.poll', requestId: `link-desktop-${++requestNo}`, params: { desktopId: linkDesktopId.desktopId, cursor: 0 } });
        const linkMs = Date.now() - started;
        expect(firstLink).toMatchObject({ type: 'result', ok: true, data: { events: [{ kind: 'offer', sdp: 'v=0 offer' }] } });
        await linkRequest({ type: 'desktop.answer', requestId: `link-desktop-${++requestNo}`, params: { desktopId: linkDesktopId.desktopId, sdp: 'v=0 answer' } });

        // Link loss ends only the signaling stream; the existing WebRTC session must remain available to relay signaling.
        link.stop();
        stream.end();

        // Relay still carries ordinary host requests and supplies the same desktop operations after a link drop.
        relayClient = new WebSocket(`${relayUrl}?role=client&machineId=machine-desktop-test`);
        await waitFor(new Promise<void>((resolve, reject) => { relayClient!.once('open', resolve); relayClient!.once('error', reject); }), 5_000, 'phone relay');
        relayClient.on('message', (data) => {
            const envelope = JSON.parse(String(data)) as Envelope;
            if (envelope?.header === undefined || typeof envelope.payload !== 'string') return;
            const frame = decodePayload<HostFrame>(envelope.payload);
            if ('requestId' in frame) {
                const settle = relayResults.get(frame.requestId);
                if (settle !== undefined) { relayResults.delete(frame.requestId); settle(frame); }
            }
        });
        const relayRequest = (frame: ClientFrame): Promise<HostFrame> => new Promise((resolve) => {
            if (!('requestId' in frame)) throw new Error('desktop request needs a request id');
            relayResults.set(frame.requestId, resolve);
            relayClient!.send(JSON.stringify({ header: { machineId: 'machine-desktop-test', seq: Date.now(), at: Date.now() }, payload: encodePayload(frame) }));
        });
        const fallbackPoll = await relayRequest({ type: 'desktop.poll', requestId: 'relay-fallback-poll', params: { desktopId: linkDesktopId.desktopId, cursor: 0 } });
        expect(fallbackPoll).toMatchObject({ type: 'result', ok: true, data: { events: [{ kind: 'offer', sdp: 'v=0 offer' }] } });
        expect(await relayRequest({ type: 'desktop.answer', requestId: 'relay-fallback-answer', params: { desktopId: linkDesktopId.desktopId, sdp: 'v=0 answer after link loss' } })).toMatchObject({ type: 'result', ok: true });
        expect(await relayRequest({ type: 'desktop.close', requestId: 'relay-fallback-close', params: { desktopId: linkDesktopId.desktopId } })).toMatchObject({ type: 'result', ok: true });

        const relayStart = Date.now();
        const openedRelay = await relayRequest({ type: 'desktop.open', requestId: 'relay-open', params: { permissions: ['view'], maxWidth: 640, maxHeight: 480 } });
        const relayId = responseData<{ desktopId: string }>(openedRelay);
        const firstRelay = await relayRequest({ type: 'desktop.poll', requestId: 'relay-poll', params: { desktopId: relayId.desktopId, cursor: 0 } });
        const relayMs = Date.now() - relayStart;
        expect(firstRelay).toMatchObject({ type: 'result', ok: true, data: { events: [{ kind: 'offer', sdp: 'v=0 offer' }] } });
        expect(await relayRequest({ type: 'desktop.close', requestId: 'relay-close', params: { desktopId: relayId.desktopId } })).toMatchObject({ type: 'result', ok: true });
        process.stdout.write(`desktop first offer: link=${linkMs}ms relay=${relayMs}ms\n`);

        stream.end();
        relayClient.close();
        machineSocket.close();
    });
});

function responseData<T>(frame: HostFrame): T {
    if (frame.type !== 'result' || !frame.ok) throw new Error('desktop request failed');
    return frame.data as T;
}

function result(frame: ClientFrame, data: unknown): HostFrame {
    if (!('requestId' in frame)) throw new Error('desktop request needs a request id');
    return { type: 'result', requestId: frame.requestId, ok: true, data } as HostFrame;
}
