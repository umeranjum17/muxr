import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceLink, hostId, type DeviceGrant } from '@byokit/link';
import { decodePayload, encodePayload, type ClientFrame, type Envelope, type HostFrame } from '@muxr/contract';
import { generateKeyPair } from '@muxr/crypto';
import { startRelay } from '@muxr/relay';
import type { AgentWatchStores, SessionSource } from '../../agent/index.js';
import { startHost, type Host as MuxrHost } from '../../host.js';
import type { MachineCryptoState } from '../domain/crypto.js';
import { LinkEndpoint } from './linkEndpoint.js';

const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64');
const b64url = (value: string): string => Buffer.from(value, 'base64').toString('base64url');
const STUB = (log: string): string => `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
let opened = 0;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const caps = { protocol: 2, engine: 'stub/0', platform: 'linux', session: { kind: 'wayland' }, capture: { mechanism: 'stub', formats: [], cursor: 'embedded', audio: false }, encode: { codecs: ['vp9'], hardware: false }, input: { mechanism: 'stub', pointer: true, wheel: true, keyboard: true, text: ['latin1'], unavailable_reason: null, grant: 'granted' }, clipboard: { read: true, write: true, mime: [], maxBytes: 1024 } };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
 const request = JSON.parse(line);
 if (request.method === 'hello' || request.method === 'capabilities') return out({ id: request.id, result: caps });
 if (request.method === 'session.open') {
   const sessionId = 'engine-' + (++opened);
   out({ event: 'session.description', params: { sessionId, generation: 1, description: { type: 'offer', sdp: 'v=0 offer' } } });
   return out({ id: request.id, result: { sessionId, generation: 1, source: { kind: 'monitor', width: 100, height: 100, origin: { x: 0, y: 0 } }, geometry: { source: { width: 100, height: 100 }, encoded: { width: 100, height: 100 }, origin: { x: 0, y: 0 } } } });
 }
 if (request.method === 'session.description' || request.method === 'session.candidate') return out({ id: request.id, result: { accepted: true } });
 if (request.method === 'session.close') { fs.appendFileSync(log, JSON.stringify(request.params) + '\\n'); return out({ id: request.id, result: { closed: true } }); }
 if (request.method === 'shutdown') return out({ id: request.id, result: { closed: true } });
 out({ id: request.id, error: { code: 'operation', message: 'unknown ' + request.method } });
});
`;

async function until<T>(read: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        const value = read();
        if (value !== undefined) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out: ${label}`);
}

function linkGrant(machine: string, phone: string, deviceId: string, port: number): DeviceGrant {
    return {
        v: 1,
        secretKey: b64url(phone),
        host: b64url(machine),
        hostName: 'test machine',
        urls: [`ws://127.0.0.1:${port}/link/v1/${hostId(Buffer.from(machine, 'base64'))}`],
        device: { id: 'pending', name: deviceId, role: 'control' },
    };
}

function desktopStream(link: DeviceLink): Promise<{
    stream: Awaited<ReturnType<DeviceLink['stream']>>;
    request: (type: Extract<ClientFrame, { requestId: string }>['type'], params: object) => Promise<HostFrame>;
}> {
    return link.stream('desktop', {}).then((stream) => {
        let buffer = '';
        const waiters = new Map<string, (frame: HostFrame) => void>();
        stream.onData = (chunk) => {
            buffer += Buffer.from(chunk).toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const frame = JSON.parse(line) as HostFrame;
                if ('requestId' in frame) waiters.get(frame.requestId)?.(frame);
            }
        };
        let sequence = 0;
        return {
            stream,
            request: async (type, params) => {
                const requestId = `desktop-${++sequence}`;
                const response = new Promise<HostFrame>((resolve) => waiters.set(requestId, resolve));
                await stream.write(`${JSON.stringify({ type, requestId, params })}\n`);
                const result = await Promise.race([
                    response,
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${type} timed out`)), 5_000)),
                ]);
                waiters.delete(requestId);
                return result;
            },
        };
    });
}

describe('desktop signaling over the byokit link (real relay + host)', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

    it('rejects relay signaling and keeps device-owned sessions across replacement streams until revoke or link grace expires', { timeout: 60_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-link-desktop-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const previousWayland = process.env.WAYLAND_DISPLAY;
        process.env.WAYLAND_DISPLAY = 'wayland-0';
        cleanups.push(() => {
            if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
            else process.env.WAYLAND_DISPLAY = previousWayland;
        });
        const engineLog = join(dir, 'engine-close.jsonl');
        writeFileSync(engineLog, '');
        const engine = join(dir, 'desktop-engine.cjs');
        writeFileSync(engine, STUB(engineLog));
        chmodSync(engine, 0o755);
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay'), developmentApi: true, advertiseMdns: false } });
        cleanups.push(() => void relay.close());
        const relayUrl = `ws://127.0.0.1:${relay.port}/relay`;
        const machineId = 'machine-desktop-test';
        const relayStates: string[] = [];
        const source = {
            subscribe: () => () => undefined,
            dispose: async () => undefined,
            resendCumulativeState: () => undefined,
        } as unknown as SessionSource;
        const domain = { unread: { acknowledge: () => undefined, noteActivity: () => undefined } } as unknown as AgentWatchStores;
        const host: MuxrHost = startHost({
            relayUrl, machineId, source, domain, desktopEnginePath: engine, stateRoot: join(dir, 'host-state'),
            onStateChange: (state) => relayStates.push(state),
        });
        cleanups.push(() => void host.close());
        await until(() => relayStates.includes('open') ? true : undefined, 'real host relay connection');

        const machine = generateKeyPair();
        const phoneA = generateKeyPair();
        const phoneB = generateKeyPair();
        let crypto: MachineCryptoState = {
            signingPublicKey: b64(new Uint8Array(32)), signingSecretKey: b64(new Uint8Array(64)),
            boxPublicKey: machine.publicKey, boxSecretKey: machine.secretKey, dataKey: b64(new Uint8Array(32)), keyVersion: 1,
            devices: [phoneA, phoneB].map((phone, index) => ({
                deviceId: `desktop-phone-${index}`,
                devicePublicKey: phone.publicKey,
                ingressKey: b64(new Uint8Array(32)),
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                authority: 'control' as const,
            })),
        };
        const linkStates = new Map<string, boolean>();
        const activeStreams = new Set<string>();
        const endpoint = await LinkEndpoint.open({
            relayUrl,
            ownerToken: JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string,
            machineName: 'test machine',
            crypto,
            currentCrypto: () => crypto,
            answer: host.answer,
            canView: host.canView,
            onDesktopConnection: (id, active) => {
                host.setLinkDesktopConnection(id, active);
                if (active) activeStreams.add(id); else activeStreams.delete(id);
            },
            onDeviceConnection: (id, active) => {
                linkStates.set(id, active);
                host.setLinkDeviceConnection(id, active);
            },
            onDeviceRevoked: (id) => host.closeDeviceDesktopSessions(id),
        });
        expect(endpoint).toBeDefined();
        cleanups.push(() => endpoint!.close());
        endpoint!.start();

        const phoneLink = (keys: typeof phoneA, id: string): DeviceLink => {
            const device = new DeviceLink(linkGrant(machine.publicKey, keys.secretKey, id, relay.port), { WebSocket });
            cleanups.push(() => device.stop());
            return device;
        };
        const a = phoneLink(phoneA, 'desktop-phone-0');
        await until(() => linkStates.get('desktop-phone-0') === true ? true : undefined, 'phone A is live on link');
        const first = await desktopStream(a);
        await until(() => activeStreams.size === 1 ? true : undefined, 'first desktop stream is registered');
        const openedA = await first.request('desktop.open', { permissions: ['view'] });
        expect(openedA).toMatchObject({ type: 'result', ok: true });
        const sessionA = responseData<{ desktopId: string }>(openedA);
        expect(await first.request('desktop.poll', { desktopId: sessionA.desktopId, cursor: 0 }))
            .toMatchObject({ type: 'result', ok: true, data: { events: [{ kind: 'offer', sdp: 'v=0 offer' }] } });

        const otherPhone = phoneLink(phoneB, 'desktop-phone-1');
        await until(() => linkStates.get('desktop-phone-1') === true ? true : undefined, 'second phone is live on link');
        const otherStream = await desktopStream(otherPhone);
        expect(await otherStream.request('desktop.poll', { desktopId: sessionA.desktopId, cursor: 0 }))
            .toMatchObject({ type: 'result', ok: false, error: 'that desktop session belongs to another device' });
        otherStream.stream.end();
        otherPhone.stop();
        await until(() => linkStates.get('desktop-phone-1') === false ? true : undefined, 'second phone disconnects');
        await until(() => activeStreams.size === 1 ? true : undefined, 'second phone stream ends');

        // A replacement stream is a distinct live connection; ending the old one cannot revoke device ownership.
        const replacement = await desktopStream(a);
        await until(() => activeStreams.size === 2 ? true : undefined, 'replacement stream is registered');
        first.stream.end();
        await until(() => activeStreams.size === 1 ? true : undefined, 'old stream ends independently');
        expect(await replacement.request('desktop.poll', { desktopId: sessionA.desktopId, cursor: 0 }))
            .toMatchObject({ type: 'result', ok: true, data: { events: [{ kind: 'offer', sdp: 'v=0 offer' }] } });

        // The relay remains up for ordinary control-plane work, but cannot carry desktop signaling.
        const client = new WebSocket(`${relayUrl}?role=client&machineId=${machineId}`);
        cleanups.push(() => client.close());
        await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
        let relaySeq = 0;
        let relayResult: ((frame: HostFrame) => void) | undefined;
        client.on('message', (raw) => {
            const envelope = JSON.parse(String(raw)) as Envelope;
            if (typeof envelope.payload !== 'string') return;
            const frame = decodePayload<HostFrame>(envelope.payload);
            if (frame.type === 'result' && relayResult !== undefined) relayResult(frame);
        });
        const rejected = new Promise<HostFrame>((resolve) => { relayResult = resolve; });
        client.send(JSON.stringify({
            header: { machineId, seq: ++relaySeq, at: Date.now() },
            payload: encodePayload({ type: 'desktop.open', requestId: 'relay-desktop', params: { permissions: ['view'] } } satisfies ClientFrame),
        }));
        expect(await Promise.race([rejected, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay request timed out')), 5_000))]))
            .toMatchObject({ type: 'result', requestId: 'relay-desktop', ok: false, error: 'desktop signaling requires the byokit link' });

        // Once the device link stays gone, the session closes after its grace; relay connectivity does not own it.
        replacement.stream.end();
        a.stop();
        await until(() => linkStates.get('desktop-phone-0') === false ? true : undefined, 'phone A link goes offline');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(readFileSync(engineLog, 'utf8')).toBe('');
        const reconnectedA = phoneLink(phoneA, 'desktop-phone-0');
        await until(() => linkStates.get('desktop-phone-0') === true ? true : undefined, 'phone A reconnects within grace');
        const resumed = await desktopStream(reconnectedA);
        await until(() => activeStreams.size === 1 ? true : undefined, 'reconnected desktop stream is registered');
        expect(await resumed.request('desktop.poll', { desktopId: sessionA.desktopId, cursor: 0 }))
            .toMatchObject({ type: 'result', ok: true, data: { events: [{ kind: 'offer', sdp: 'v=0 offer' }] } });
        resumed.stream.end();
        reconnectedA.stop();
        await until(() => linkStates.get('desktop-phone-0') === false ? true : undefined, 'phone A link disconnects again');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(readFileSync(engineLog, 'utf8')).toBe('');
        await until(() => readFileSync(engineLog, 'utf8').trim() !== '' ? true : undefined, 'link grace closes phone A session', 25_000);
        expect(readFileSync(engineLog, 'utf8').trim().split('\n')).toHaveLength(1);

        const b = phoneLink(phoneB, 'desktop-phone-1');
        await until(() => linkStates.get('desktop-phone-1') === true ? true : undefined, 'phone B is live on link');
        const bStream = await desktopStream(b);
        const openedB = await bStream.request('desktop.open', { permissions: ['view'] });
        expect(openedB).toMatchObject({ type: 'result', ok: true });
        const sessionB = responseData<{ desktopId: string }>(openedB);
        crypto = { ...crypto, devices: crypto.devices.filter((device) => device.deviceId !== 'desktop-phone-1') };
        expect(await endpoint!.sync(crypto)).toBe(true);
        await until(() => readFileSync(engineLog, 'utf8').trim().split('\n').length === 2 ? true : undefined, 'revocation closes phone B session immediately');
        await until(() => b.status === 'removed' ? true : undefined, 'revoked phone is removed from the link');
        expect(sessionB.desktopId).toBeTruthy();
        b.stop();
        client.close();
    });
});

function responseData<T>(frame: HostFrame): T {
    if (frame.type !== 'result' || !frame.ok) throw new Error('desktop request failed');
    return frame.data as T;
}
