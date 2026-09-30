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
import { openNotice } from '@byokit/seal';
import { runInNewContext } from 'node:vm';
import { openLifecycleNotice } from '../../../apps/mobile/sources/utils/openLifecycleNotice';
import { watchAgentLifecycle } from '../../../apps/mobile/sources/herd/application/WatchAgentLifecycle';

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
import { fileRelayClientStore, LinkEndpoint } from '../../../apps/host/src/machine/infrastructure/linkEndpoint.js';

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
            config: { dataDir, advertiseMdns: false },
        });
        let liveEndpoint: { close(): void } | undefined;
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
            liveEndpoint = endpoint;
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
            expect(blocked.title).toBe('Agent update');
            expect(blocked.body).toBe('An agent has an update.');
            expect(JSON.stringify(blocked)).not.toContain('Ship it');
            expect(JSON.stringify(blocked)).not.toContain('Maria');
            expect(blocked.collapseId).toMatch(/^[a-f0-9]{64}$/);
            expect(blocked.priority).toBe('high');
            // The phone claims lifecycle pushes by these nested fields.
            const envelope = blocked.data as { id: string; data: Record<string, unknown> };
            expect(Object.keys(envelope.data).sort()).toEqual(['sealed', 'v']);
            const payload = openNotice(envelope.data, deviceSecret) as { title: string; body: string; data: Record<string, unknown> };
            expect(payload.title).toBe('Ship it');
            expect(payload.body).toBe('Maria needs attention.');
            expect(payload.data.presentationOwner).toBe('relay-push');
            expect(payload.data.eventId).toBe('evt-1');
            expect(payload.data.machineId).toBe('machine-push-test');
            expect(payload.data.agentName).toBe('Maria');
            const paired = [{ machineId: 'machine-push-test', deviceKey: { secretKey: deviceSecret.toString('base64') } }];
            const opened = openLifecycleNotice(envelope, paired);
            expect(opened.title).toBe('Ship it');
            expect(watchAgentLifecycle({ notificationData: opened.data, activeMachineId: 'machine-push-test' }).agentRoute).toBe('s1');
            expect(watchAgentLifecycle({ notificationData: opened.data, activeMachineId: 'machine-B' })).toEqual({ agentRoute: null, selectMachine: true });
            expect(openLifecycleNotice(envelope, [{ ...paired[0], deviceKey: { secretKey: randomBytes(32).toString('base64') } }])).toEqual({
                title: 'Agent update', body: 'An agent has an update.', data: {},
            });
            const workerHandlers = new Map<string, (event: unknown) => void>();
            const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
            let target = '';
            const worker = {
                addEventListener: (type: string, handler: (event: unknown) => void) => workerHandlers.set(type, handler),
                openLifecyclePush: async (data: unknown) => openLifecycleNotice(data, paired),
                registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
                clients: { matchAll: async () => [], openWindow: async (url: string) => { target = url; } },
            };
            runInNewContext(readFileSync(new URL('../../../apps/mobile/public/sw.js', import.meta.url), 'utf8'), {
                self: worker, importScripts: () => undefined,
                caches: { open: async () => ({ match: async () => null }) },
            });
            let pending = Promise.resolve();
            const waitUntil = (work: Promise<void>) => { pending = work; };
            workerHandlers.get('push')!({ data: { json: () => envelope }, waitUntil });
            await pending;
            expect(shown[0].title).toBe('Ship it');
            expect(shown[0].options.body).toBe('Maria needs attention.');
            workerHandlers.get('notificationclick')!({ notification: { data: shown[0].options.data, close: () => undefined }, waitUntil });
            await pending;
            expect(target).toBe('/notification#machineId=machine-push-test&sessionId=s1');
            const tapUrl = new URL(target, 'https://app.test');
            expect(tapUrl.pathname + tapUrl.search).toBe('/notification');
            const tapParams = new URLSearchParams(tapUrl.hash.slice(1));
            const tapData = { machineId: tapParams.get('machineId'), sessionId: tapParams.get('sessionId') };
            expect(watchAgentLifecycle({ notificationData: tapData, activeMachineId: 'machine-B' })).toEqual({ agentRoute: null, selectMachine: true });
            expect(watchAgentLifecycle({ notificationData: tapData, activeMachineId: 'machine-push-test' })).toEqual({ agentRoute: 's1', selectMachine: false });
            worker.clients.matchAll = async () => [{ navigate: async (url: string) => { target = url; }, focus: async () => undefined }] as never;
            target = '';
            workerHandlers.get('notificationclick')!({ notification: { data: shown[0].options.data, close: () => undefined }, waitUntil });
            await pending;
            expect(target).toBe('/notification#machineId=machine-push-test&sessionId=s1');
            const focusedTapUrl = new URL(target, 'https://app.test');
            expect(focusedTapUrl.pathname + focusedTapUrl.search).toBe('/notification');



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
            liveEndpoint = endpoint;
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
            const beforeFanout = expoSends.length;
            endpoint.notifyAttention({ sessionId: 's1', eventId: 'evt-fanout', kind: 'blocked', machineId: 'machine-push-test', agentName: 'Maria', taskTitle: 'Ship it' });
            await until(() => expoSends.length === beforeFanout + 2 ? true : undefined, 'both recipients receive sealed notices');
            const fanout = expoSends.slice(beforeFanout);
            expect(new Set(fanout.map((send) => send.collapseId)).size).toBe(2);
            for (const send of fanout) {
                const secret = send.to === 'ExponentPushToken[muxr-test-token]' ? deviceSecret : revokedSecret;
                const other = send.to === 'ExponentPushToken[muxr-test-token]' ? revokedSecret : deviceSecret;
                expect(openNotice((send.data as { data: unknown }).data, secret)).toMatchObject({ title: 'Ship it' });
                expect(openNotice((send.data as { data: unknown }).data, other)).toBeNull();
                expect(JSON.stringify(send)).not.toContain('Maria');
            }
            endpoint.notifyAttention({ sessionId: 's1', eventId: 'evt-all-done', kind: 'done', machineId: 'machine-push-test', agentName: 'Maria', taskTitle: 'Ship it' });
            await until(() => expoSends.length === beforeFanout + 3 ? true : undefined, 'all-level recipient receives done');
            expect(openNotice((expoSends.at(-1)!.data as { data: unknown }).data, revokedSecret)).toMatchObject({ body: 'Maria finished.' });
            endpoint.notifyAttention({ sessionId: 's1', eventId: 'evt-all-failed', kind: 'failed', reasonCode: 'start-timeout', machineId: 'machine-push-test', agentName: 'Maria', taskTitle: 'Ship it' });
            await until(() => expoSends.length === beforeFanout + 5 ? true : undefined, 'both recipients receive failed');
            expect(openNotice((expoSends.at(-1)!.data as { data: unknown }).data,
                expoSends.at(-1)!.to === 'ExponentPushToken[muxr-test-token]' ? deviceSecret : revokedSecret)).toMatchObject({ body: 'Maria could not start.' });
            const afterSecond = expoSends.length;
            await until(() => (expoSends.length >= afterSecond ? true : undefined), 'second registration recorded');
            const relayStore = () => readFileSync(join(dataDir, 'link-relay.json'), 'utf8');
            expect(relayStore()).toContain('muxr-revoked-token');
            // The host drops the device; its grant and its push registration on the relay go.
            currentCrypto = { ...currentCrypto, devices: currentCrypto.devices.filter((entry) => entry.deviceId !== 'dev_push_2') };
            writeFileSync(statePath, JSON.stringify(currentCrypto));
            expect(await endpoint.sync(currentCrypto as never)).toBe(true);
            await until(() => (relayStore().includes('muxr-revoked-token') ? undefined : true), 'relay drops the removed device\'s push address');
            await expect(revokedLink.request('push.subscribe', {
                type: 'push.subscribe', requestId: 'rn-3', params: { token: 'ExponentPushToken[muxr-revoked-token]', level: 'all' },
            }, { timeoutMs: 2_000 })).rejects.toThrow();
            expect(relayStore()).not.toContain('muxr-revoked-token');
            endpoint.notifyAttention({
                sessionId: 's1', eventId: 'evt-4', kind: 'blocked', machineId: 'machine-push-test',
                reasonCode: 'agent-blocked', agentName: 'Maria', taskTitle: 'Ship it',
            });
            await until(() => (expoSends.length >= afterSecond + 1 ? true : undefined), 'delivery after revoke');
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(expoSends.length).toBe(afterSecond + 1);
            expect(expoSends.at(-1)!.to).toBe('ExponentPushToken[muxr-test-token]');

            for (const [index, unsafeTitle] of ['token=secret-value', '/home/private/task'].entries()) {
                const count = expoSends.length;
                endpoint.notifyAttention({
                    sessionId: 's1', eventId: `evt-private-${index}`, kind: 'blocked', machineId: 'machine-push-test',
                    reasonCode: 'agent-blocked', agentName: 'Maria', taskTitle: unsafeTitle,
                });
                const delivery = await until(() => expoSends.length > count ? expoSends.at(-1) : undefined, 'private title notification');
                expect(delivery.title).toBe('Agent update');
                const notice = openNotice((delivery.data as { data: unknown }).data, deviceSecret) as { title: string; data: Record<string, unknown> };
                expect(notice.title).toBe('Agent update');
                expect(notice.data).not.toHaveProperty('taskTitle');
                expect(JSON.stringify(delivery)).not.toContain(unsafeTitle);
            }
            revokedLink.stop();
        } finally {
            liveEndpoint?.close();
            await relay.close();
            rmSync(dataDir, { recursive: true, force: true });
        }
    }, 30_000);

    it('a revoke queued while the relay is down unsubscribes after a host restart', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'muxr-link-revoke-restart-'));
        const openRelay = () => startRelay({
            port: 0,
            host: '127.0.0.1',
            linkPush: { fetch: capturedFetch },
            config: { dataDir, advertiseMdns: false },
        });
        let relay = await openRelay();
        try {
            const mint = JSON.parse(readFileSync(join(dataDir, 'mint-secret'), 'utf8')) as string;
            const machineSecret = randomBytes(32);
            const machineKeys = keyPairFrom(machineSecret);
            const deviceSecret = randomBytes(32);
            const deviceKeys = keyPairFrom(deviceSecret);
            const crypto = {
                boxSecretKey: Buffer.from(machineSecret).toString('base64'),
                boxPublicKey: Buffer.from(machineKeys.publicKey).toString('base64'),
                devices: [{
                    deviceId: 'dev_restart_1',
                    devicePublicKey: Buffer.from(deviceKeys.publicKey).toString('base64'),
                    authority: 'control',
                    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                }],
            };
            const statePath = join(dataDir, 'host-devices.json');
            writeFileSync(statePath, JSON.stringify(crypto));
            const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as typeof crypto;
            const grantsPath = join(dataDir, 'host-grants.json');
            writeFileSync(grantsPath, '[]');
            const storePath = join(dataDir, 'link-revoked.json');
            const openEndpoint = (port: number) => LinkEndpoint.open({
                savePushLevel: () => {},
                grants: {
                    load: () => JSON.parse(readFileSync(grantsPath, 'utf8')) as never,
                    save: (grants) => writeFileSync(grantsPath, JSON.stringify(grants)),
                },
                revokeStore: fileRelayClientStore(storePath),
                relayUrl: `ws://127.0.0.1:${port}`,
                ownerToken: mint,
                machineId: 'machine-restart-test',
                machineName: 'Desk',
                crypto: crypto as never,
                currentCrypto: () => readState() as never,
                answer: async () => undefined,
                canView: () => false,
            });
            const grant: DeviceGrant = {
                v: 1,
                secretKey: b64url(deviceSecret),
                host: b64url(machineKeys.publicKey),
                hostName: 'Desk',
                urls: [`ws://127.0.0.1:${relay.port}/link/v1/${hostId(machineKeys.publicKey)}`],
                device: { id: '', name: 'Phone', role: 'control' },
            };
            let endpoint = (await openEndpoint(relay.port))!;
            endpoint.start();
            const link = new DeviceLink(grant, {});
            await link.request('push.subscribe', {
                type: 'push.subscribe', requestId: 'rn-1', params: {
                    token: 'ExponentPushToken[muxr-restart-token]',
                    level: 'all',
                },
            }, { timeoutMs: 5_000 });
            const relayStore = () => readFileSync(join(dataDir, 'link-relay.json'), 'utf8');
            expect(relayStore()).toContain('muxr-restart-token');

            // The relay goes down, then the device is removed: the local
            // grant is gone at once while the unsubscribe waits in the file.
            await relay.close();
            const without = { ...readState(), devices: [] as typeof crypto.devices };
            writeFileSync(statePath, JSON.stringify(without));
            expect(await endpoint.sync(without as never)).toBe(true);
            await until(() => {
                try {
                    const pending = JSON.parse(readFileSync(storePath, 'utf8')) as unknown;
                    return Array.isArray(pending) && pending.length > 0 ? true : undefined;
                } catch { return undefined; }
            }, 'revoke persists the pending unsubscribe');
            endpoint.close();
            link.stop();

            // A new host on the same store file finishes it once the relay answers.
            relay = await openRelay();
            endpoint = (await openEndpoint(relay.port))!;
            endpoint.start();
            await until(() => (relayStore().includes('muxr-restart-token') ? undefined : true),
                'relay drops the token after the restarted host resends');
            endpoint.close();
        } finally {
            await relay.close().catch(() => {});
            rmSync(dataDir, { recursive: true, force: true });
        }
    }, 30_000);
});
