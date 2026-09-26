/**
 * Push moves onto the byokit relay for link devices (step 5).
 *
 * One flow against the real link relay (in-process, Expo deliveries captured),
 * the real host endpoint and a real link device: the device registers its Expo
 * push address over the link (`push.subscribe`), the host fans a lifecycle
 * notification out through the relay's push, and the Expo send carries the
 * address, the copy and the lifecycle fields the phone claims. The level each
 * device chose decides who is woken; a revoked device stops being woken.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceLink, hostId, keyPairFrom, type DeviceGrant } from '@byokit/link';
import { describe, expect, it } from 'vitest';

const expoSends: Array<Record<string, unknown>> = [];
const capturedFetch: typeof fetch = async (url, init) => {
    if (String(url).startsWith('https://exp.host')) {
        const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
        expoSends.push(...body);
        return new Response(JSON.stringify({ data: body.map(() => ({ status: 'ok' })) }), { status: 200 });
    }
    return fetch(url, init);
};

import { startRelay } from '../../../apps/relay/src/relay.js';
import { LinkEndpoint } from '../../../apps/host/src/machine/infrastructure/linkEndpoint.js';

const b64url = (value: Uint8Array | Buffer): string => Buffer.from(value).toString('base64url');
const until = async <T>(produce: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = produce();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

describe('push rides the byokit link relay', () => {
    it('registers a device over the link, delivers through the relay, and honours levels and revoke', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'muxr-link-push-'));
        const relay = await startRelay({
            port: 0,
            host: '127.0.0.1',
            linkPush: { fetch: capturedFetch },
            config: { dataDir, advertiseMdns: false, e2eeMode: 'off', localAuthority: true, developmentApi: false },
        });
        try {
            const mint = JSON.parse(readFileSync(join(dataDir, 'mint-secret'), 'utf8')) as string;
            const machineSecret = randomBytes(32);
            const machineKeys = keyPairFrom(machineSecret);
            const deviceSecret = randomBytes(32);
            const deviceKeys = keyPairFrom(deviceSecret);
            // The host enroled this phone from its own device records (decision D2).
            const crypto = {
                boxSecretKey: Buffer.from(machineSecret).toString('base64'),
                boxPublicKey: Buffer.from(machineKeys.publicKey).toString('base64'),
                devices: [{
                    deviceId: 'dev_push_1',
                    devicePublicKey: Buffer.from(deviceKeys.publicKey).toString('base64'),
                    authority: 'control',
                    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                }],
            };
            type PushCrypto = typeof crypto & { devices: Array<(typeof crypto.devices)[number] & { pushLevel?: 'all' | 'important' | 'off' }> };
            const statePath = join(dataDir, 'host-devices.json');
            const readState = (): PushCrypto => JSON.parse(readFileSync(statePath, 'utf8')) as PushCrypto;
            writeFileSync(statePath, JSON.stringify(crypto));
            const savePushLevel = (deviceId: string, level: 'all' | 'important' | 'off' | undefined) => {
                const next = readState();
                const device = next.devices.find((entry) => entry.deviceId === deviceId);
                if (device === undefined) throw new Error('device missing');
                device.pushLevel = level;
                writeFileSync(statePath, JSON.stringify(next));
            };
            let currentCrypto = readState();
            const endpointStatuses: string[] = [];
            const grantsPath = join(dataDir, 'host-grants.json');
            writeFileSync(grantsPath, '[]');
            const openEndpoint = () => LinkEndpoint.open({
                savePushLevel,
                grants: {
                    load: () => JSON.parse(readFileSync(grantsPath, 'utf8')) as never,
                    save: (grants) => writeFileSync(grantsPath, JSON.stringify(grants)),
                },
                onStatus: (status) => endpointStatuses.push(status),
                relayUrl: `ws://127.0.0.1:${relay.port}`,
                ownerToken: mint,
                machineId: 'machine-push-test',
                machineName: 'Desk',
                crypto: crypto as never,
                currentCrypto: () => readState() as never,
                answer: async () => undefined,
                canView: () => false,
            });
            let endpoint = (await openEndpoint())!;
            expect(endpoint).toBeDefined();
            // The relay socket dials only on start() (the host main wiring does the same).
            endpoint.start();

            const grant: DeviceGrant = {
                v: 1,
                secretKey: b64url(deviceSecret),
                host: b64url(machineKeys.publicKey),
                hostName: 'Desk',
                urls: [`ws://127.0.0.1:${relay.port}/link/v1/${hostId(machineKeys.publicKey)}`],
                device: { id: '', name: 'Phone', role: 'control' },
            };
            const statuses: string[] = [];
            const link = new DeviceLink(grant, { onStatus: (status) => statuses.push(status) });
            await until(() => (statuses.includes('online') ? true : undefined), 'device link comes online');
            const registration = await link.request('push.subscribe', {
                type: 'push.subscribe', requestId: 'rn-1', params: {
                    token: 'ExponentPushToken[muxr-test-token]',
                    level: 'important',
                },
            }, { timeoutMs: 5_000 });
            expect(registration).toMatchObject({ type: 'result', ok: true });

            endpoint.notifyAttention({
                sessionId: 's1', eventId: 'evt-1', kind: 'blocked', machineId: 'machine-push-test',
                reasonCode: 'agent-blocked', agentName: 'Maria', taskTitle: 'Ship it',
            });
            const blocked = await until(() => expoSends.at(-1), 'Expo delivery of the blocked notification');
            expect(blocked.to).toBe('ExponentPushToken[muxr-test-token]');
            expect(blocked.title).toBe('Ship it');
            expect(blocked.body).toBe('Maria needs attention.');
            expect(blocked.collapseId).toBe('evt-1');
            expect(blocked.priority).toBe('high');
            // The phone claims lifecycle pushes by these nested fields.
            const payload = blocked.data as { id: string; data: Record<string, unknown> };
            expect(payload.data.presentationOwner).toBe('relay-push');
            expect(payload.data.eventId).toBe('evt-1');
            expect(payload.data.machineId).toBe('machine-push-test');
            expect(payload.data.agentName).toBe('Maria');

            // An important-only device is never woken for done noise.
            endpoint.notifyAttention({
                sessionId: 's1', eventId: 'evt-2', kind: 'done', machineId: 'machine-push-test',
                reasonCode: 'agent-done', agentName: 'Maria', taskTitle: 'Ship it',
            });
            await until(() => (expoSends.length >= 1 ? true : undefined), 'first delivery recorded');
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(expoSends.length).toBe(1);

            // The registration survives a link reconnect: the host resends what
            // the relay had not answered, the device does not re-register.
            endpoint.notifyAttention({
                sessionId: 's1', eventId: 'evt-3', kind: 'blocked', machineId: 'machine-push-test',
                reasonCode: 'agent-blocked', agentName: 'Maria', taskTitle: 'Ship it',
            });
            await until(() => (expoSends.length >= 2 ? true : undefined), 'blocked notification delivered again');
            expect(expoSends[1].to).toBe('ExponentPushToken[muxr-test-token]');
            expect(readState().devices[0].pushLevel).toBe('important');
            link.stop();
            endpoint.close();
            endpoint = (await openEndpoint())!;
            endpoint.start();
            await until(() => (endpointStatuses.at(-1) === 'online' ? true : undefined), `restarted relay online: ${endpointStatuses.join(',')}`);
            expect(endpoint.enrolledKey('dev_push_1')).toBeDefined();
            expect(readState().devices[0].pushLevel).toBe('important');
            endpoint.notifyAttention({
                sessionId: 's1', eventId: 'evt-restart', kind: 'blocked', machineId: 'machine-push-test',
                reasonCode: 'agent-blocked', agentName: 'Maria', taskTitle: 'Ship it',
            });
            await until(() => (expoSends.length >= 3 ? true : undefined), 'delivery after host restart');
            expect(expoSends[2].to).toBe('ExponentPushToken[muxr-test-token]');

            // Authority is read for each send, not cached when the address registered.
            const beforeExpiry = readState();
            const expired = structuredClone(beforeExpiry);
            expired.devices[0].expiresAt = new Date(Date.now() - 1_000).toISOString();
            writeFileSync(statePath, JSON.stringify(expired));
            endpoint.notifyAttention({ sessionId: 's1', eventId: 'evt-expired', kind: 'blocked', machineId: 'machine-push-test', agentName: 'Maria' });
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(expoSends).toHaveLength(3);
            writeFileSync(statePath, JSON.stringify(beforeExpiry));
            const revoking = { ...beforeExpiry, pendingRotation: { revokedDeviceId: 'dev_push_1' } };
            writeFileSync(statePath, JSON.stringify(revoking));
            endpoint.notifyAttention({ sessionId: 's1', eventId: 'evt-revoking', kind: 'blocked', machineId: 'machine-push-test', agentName: 'Maria' });
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(expoSends).toHaveLength(3);
            writeFileSync(statePath, JSON.stringify(beforeExpiry));

            // A second device registers for everything; revoking it removes its
            // registration with its grant, so it is never woken again.
            const revokedSecret = randomBytes(32);
            const revokedKeys = keyPairFrom(revokedSecret);
            currentCrypto = readState();
            const revokedCrypto = {
                ...currentCrypto,
                devices: [...currentCrypto.devices, {
                    deviceId: 'dev_push_2',
                    devicePublicKey: Buffer.from(revokedKeys.publicKey).toString('base64'),
                    authority: 'control',
                    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                }],
            };
            currentCrypto = revokedCrypto;
            writeFileSync(statePath, JSON.stringify(currentCrypto));
            await endpoint.sync(revokedCrypto as never);
            const revokedStatuses: string[] = [];
            const revokedLink = new DeviceLink({
                ...grant,
                secretKey: b64url(revokedSecret),
                device: { id: '', name: 'Tablet', role: 'control' },
            }, { onStatus: (status) => revokedStatuses.push(status) });
            await until(() => (revokedStatuses.includes('online') ? true : undefined), 'second device online');
            await revokedLink.request('push.subscribe', {
                type: 'push.subscribe', requestId: 'rn-2', params: {
                    token: 'ExponentPushToken[muxr-revoked-token]',
                    level: 'all',
                },
            }, { timeoutMs: 5_000 });
            const afterSecond = expoSends.length;
            await until(() => (expoSends.length >= afterSecond ? true : undefined), 'second registration recorded');
            // The host drops the device; its grant and its push registration go.
            currentCrypto = { ...currentCrypto, devices: currentCrypto.devices.filter((entry) => entry.deviceId !== 'dev_push_2') };
            writeFileSync(statePath, JSON.stringify(currentCrypto));
            await endpoint.sync(currentCrypto as never);
            endpoint.notifyAttention({
                sessionId: 's1', eventId: 'evt-4', kind: 'blocked', machineId: 'machine-push-test',
                reasonCode: 'agent-blocked', agentName: 'Maria', taskTitle: 'Ship it',
            });
            await until(() => (expoSends.length >= afterSecond + 1 ? true : undefined), 'delivery after revoke');
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(expoSends.length).toBe(afterSecond + 1);
            expect(expoSends.at(-1)!.to).toBe('ExponentPushToken[muxr-test-token]');
            revokedLink.stop();
        } finally {
            await relay.close();
            rmSync(dataDir, { recursive: true, force: true });
        }
    }, 30_000);
});
