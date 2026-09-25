import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import webpush from 'web-push';
import type { Envelope } from '@muxr/contract';
import { OfflineBuffer, PeerTable, ReplayLog, routeEnvelope, type ConnectedPeer, type PeerRouteOutcome } from '../routing/index.js';
import { loadRelayConfig } from '../config.js';
import { awaitPersistChain } from './persist.js';
import { parsePushNotification, PushService } from '../push/index.js';
import { MachineRegistry, SelfhostPairing } from '../admission/index.js';
import { startRelay } from '../relay.js';

it('keeps a browser grant recoverable until its role and durable client acknowledgement are confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-browser-pairing-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
        const pairing = new SelfhostPairing(root);
        const session = await pairing.createSession({
            claim: 'c'.repeat(43),
            machineSlug: 'machine-a',
            deviceKind: 'browser',
            authority: 'control',
        });
        const claimed = await pairing.claim(session.pairId, {
            claim: 'c'.repeat(43),
            devicePublicKey: 'device-public-key',
            deviceName: 'Browser',
            deviceKind: 'browser',
            mailbox: 'sealed-mailbox',
        });
        expect(claimed.state).toBe('issued');
        if (claimed.state !== 'issued') return;
        expect(await pairing.poll(session.pairId, 'machine-a')).toMatchObject({ state: 'claimed', authority: 'control', acknowledged: false });
        await expect(pairing.uploadGrant(session.pairId, 'machine-a', 'sealed-grant')).resolves.toBe(true);
        await expect(pairing.fetchGrant(session.pairId, claimed.deviceId)).resolves.toBe('sealed-grant');
        await expect(pairing.fetchGrant(session.pairId, claimed.deviceId)).resolves.toBe('sealed-grant');
        await expect(pairing.acknowledgeGrant(session.pairId, claimed.deviceId)).resolves.toBe(true);
        expect(await pairing.poll(session.pairId, 'machine-a')).toMatchObject({ acknowledged: true });
        await expect(pairing.completeGrant(session.pairId, 'machine-a')).resolves.toBe(true);
        await expect(pairing.resolveDeviceCredential(claimed.credential)).resolves.toMatchObject({ deviceId: claimed.deviceId });
        const unfinished = await pairing.createSession({ claim: 'd'.repeat(43), machineSlug: 'machine-a', deviceKind: 'browser' });
        const waiting = await pairing.claim(unfinished.pairId, {
            claim: 'd'.repeat(43), devicePublicKey: 'other-key', deviceName: 'Browser', deviceKind: 'browser', mailbox: 'sealed',
        });
        if (waiting.state !== 'issued') throw new Error('browser claim failed');
        await expect(pairing.uploadGrant(unfinished.pairId, 'machine-a', 'other-grant')).resolves.toBe(true);
        await expect(pairing.fetchGrant(unfinished.pairId, waiting.deviceId)).resolves.toBe('other-grant');
        await expect(pairing.acknowledgeGrant(unfinished.pairId, waiting.deviceId)).resolves.toBe(true);
        vi.setSystemTime(Date.now() + 121_000);
        await expect(pairing.resolveDeviceCredential(claimed.credential)).resolves.toMatchObject({ deviceId: claimed.deviceId });
        await expect(pairing.resolveDeviceCredential(waiting.credential)).resolves.toBeUndefined();
        await expect(pairing.isDeviceActive(waiting.deviceId)).resolves.toBe(false);
        await expect(pairing.completeGrant(unfinished.pairId, 'machine-a')).resolves.toBe(false);
    } finally {
        vi.useRealTimers();
        await rm(root, { recursive: true, force: true });
    }
});

it('stops delivering both push channels when an unpublished native claim expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-claim-push-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    const sendWeb = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never);
    const sendExpo = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const tokens = JSON.parse(String(init?.body)) as unknown[];
        return new Response(JSON.stringify({ data: tokens.map(() => ({ status: 'ok' })) }), { status: 200 });
    });
    vi.stubGlobal('fetch', sendExpo);
    try {
        const pairing = new SelfhostPairing(root);
        const push = new PushService(root);
        await push.load();
        const claim = async (name: string) => {
            const session = await pairing.createSession({ claim: name, machineSlug: 'machine-a', deviceKind: 'native' });
            const issued = await pairing.claim(session.pairId, {
                claim: name, devicePublicKey: name, deviceName: name, deviceKind: 'native', mailbox: 'sealed',
            });
            if (issued.state !== 'issued') throw new Error('claim failed');
            await push.subscribe('local:machine-a', {
                endpoint: `https://push.example.com/${name}`,
                keys: { p256dh: 'key', auth: 'auth' },
            }, { deviceId: issued.deviceId });
            await push.subscribeExpo('local:machine-a', `ExpoPushToken[${name}]`, 'all', issued.deviceId);
            return { session, issued };
        };
        const pending = await claim('pending');
        const interrupted = await claim('interrupted');
        const published = await claim('published');
        expect(await pairing.uploadGrant(interrupted.session.pairId, 'machine-a', 'sealed-grant')).toBe(true);
        expect(await pairing.uploadGrant(published.session.pairId, 'machine-a', 'sealed-grant')).toBe(true);
        await expect(pairing.completeGrant(published.session.pairId, 'machine-a')).resolves.toBe(true);
        const notify = (eventId: string) => push.notify('local:machine-a', {
            eventId, kind: 'done', reasonCode: 'agent-done', agentName: 'Agent',
            taskTitle: 'Private task', sessionId: 'session-1', machineId: 'machine-a',
        }, (id) => pairing.isDeviceActive(id));
        await expect(notify('before-expiry')).resolves.toEqual({ sent: 6 });
        expect(sendWeb).toHaveBeenCalledTimes(3);
        expect(JSON.parse(String(sendExpo.mock.calls[0]?.[1]?.body))).toHaveLength(3);
        let finishWeb!: () => void;
        const stalledWeb = new Promise<void>((resolve) => { finishWeb = resolve; });
        sendWeb.mockImplementationOnce(async () => { await stalledWeb; return {} as never; });
        const crossing = notify('crossing-window');
        await vi.waitFor(() => expect(sendWeb).toHaveBeenCalledTimes(6));
        vi.setSystemTime(Date.now() + 121_000);
        finishWeb();
        await expect(crossing).resolves.toEqual({ sent: 4 });
        expect(JSON.parse(String(sendExpo.mock.calls[1]?.[1]?.body))).toEqual([
            expect.objectContaining({ to: 'ExpoPushToken[published]' }),
        ]);
        await expect(pairing.isDeviceActive(pending.issued.deviceId)).resolves.toBe(false);
        await expect(pairing.isDeviceActive(interrupted.issued.deviceId)).resolves.toBe(false);
        await expect(pairing.isDeviceActive(published.issued.deviceId)).resolves.toBe(true);
        await expect(notify('after-expiry')).resolves.toEqual({ sent: 2 });
        expect(sendWeb).toHaveBeenCalledTimes(7);
        expect(sendWeb.mock.calls[6]?.[0]).toMatchObject({ endpoint: 'https://push.example.com/published' });
        expect(JSON.parse(String(sendExpo.mock.calls[2]?.[1]?.body))).toEqual([
            expect.objectContaining({ to: 'ExpoPushToken[published]' }),
        ]);
    } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        sendWeb.mockRestore();
        await rm(root, { recursive: true, force: true });
    }
});

it('issues a constrained peer credential, carries its metadata through rotation, then fails closed after revoke', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-peer-authority-'));
    try {
        const pairing = new SelfhostPairing(root);
        const issued = await pairing.issuePeer({
            machineSlug: 'machine-target',
            publicKey: Buffer.alloc(32, 7).toString('base64'),
            name: 'Linux builder',
            peerMachineId: 'machine-source',
            capabilities: ['list', 'read', 'status', 'watch', 'prompt'],
            authorityId: 'selfhost:test',
        });
        expect(issued).toBeDefined();
        if (issued === undefined) return;

        await expect(pairing.storePeerGrant(issued.deviceId, 'machine-target', 'opaque-signed-grant', 3)).resolves.toBe(true);
        await expect(pairing.resolveDeviceCredential(issued.credential)).resolves.toEqual({
            deviceId: issued.deviceId,
            machineSlug: 'machine-target',
            deviceKind: 'peer',
            capabilities: ['list', 'read', 'status', 'watch', 'prompt'],
            credentialVersion: 1,
        });
        await expect(pairing.listPeers('machine-target')).resolves.toEqual([
            expect.objectContaining({
                deviceId: issued.deviceId,
                peerMachineId: 'machine-source',
                capabilities: ['list', 'read', 'status', 'watch', 'prompt'],
                keyVersion: 3,
                authorityId: 'selfhost:test',
            }),
        ]);

        const rotated = await pairing.rotatePeerCredential(issued.deviceId, 'machine-target');
        expect(rotated).toBeDefined();
        if (rotated === undefined) return;
        await expect(pairing.resolveDeviceCredential(issued.credential)).resolves.toBeUndefined();
        await expect(pairing.isDeviceActive(issued.deviceId, 1)).resolves.toBe(false);
        await expect(pairing.resolveDeviceCredential(rotated.credential)).resolves.toMatchObject({
            deviceKind: 'peer', credentialVersion: 2,
        });

        await expect(pairing.revokeDevice(issued.deviceId, 'machine-target')).resolves.toEqual({ machineSlug: 'machine-target' });
        await expect(pairing.resolveDeviceCredential(rotated.credential)).resolves.toBeUndefined();
        await expect(pairing.fetchCurrentGrant(issued.deviceId, 'machine-target')).resolves.toBeUndefined();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

it('reports a self-host peer tenant mismatch instead of claiming the target is offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-peer-route-'));
    try {
        const peers = new PeerTable();
        const socket = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as import('ws').WebSocket;
        const target: ConnectedPeer = {
            socket, identity: { role: 'machine', machineIds: new Set(['mac']), accountId: 'local:mac', transport: 'relay' },
            accountId: 'local:mac', role: 'machine', machineIds: new Set(['mac']), connectedAt: Date.now(),
        };
        const source: ConnectedPeer = {
            socket: { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as import('ws').WebSocket,
            identity: {
                role: 'client', machineIds: new Set(['mac']), accountId: 'local:linux',
                deviceKind: 'peer', transport: 'relay',
            },
            accountId: 'local:linux', role: 'client', machineIds: new Set(['mac']), connectedAt: Date.now(),
        };
        peers.add(target);
        const outcomes: PeerRouteOutcome[] = [];
        const envelope: Envelope = { header: { machineId: 'mac', seq: 1, at: Date.now() }, payload: 'opaque-ciphertext' };
        const result = routeEnvelope(envelope, source, peers, new OfflineBuffer(root, 10, 60_000), new ReplayLog(root, 10, 60_000), {
            onPeerRoute: (outcome) => outcomes.push(outcome),
        });
        expect(result).toEqual({ delivered: 0, buffered: true, pushNotified: false });
        expect(outcomes).toEqual(['tenant-mismatch']);
        expect(socket.send).not.toHaveBeenCalled();

        const sameTenantSource: ConnectedPeer = {
            ...source,
            accountId: 'local:mac',
            identity: {
                role: 'client', machineIds: new Set(['mac']), accountId: 'local:mac',
                deviceKind: 'peer', transport: 'relay',
            },
        };
        expect(routeEnvelope(envelope, sameTenantSource, peers, new OfflineBuffer(root, 10, 60_000), new ReplayLog(root, 10, 60_000), {
            onPeerRoute: (outcome) => outcomes.push(outcome),
        })).toEqual({ delivered: 1, buffered: false, pushNotified: false });
        expect(outcomes).toEqual(['tenant-mismatch', 'delivered']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

it('delivers an artifact chunk only to the socket that asked, and never replays it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-artifact-route-'));
    try {
        const peers = new PeerTable();
        const socket = () => ({ OPEN: 1, readyState: 1, send: vi.fn() }) as unknown as import('ws').WebSocket;
        const peer = (role: 'machine' | 'client', ws: import('ws').WebSocket, connectionId?: string): ConnectedPeer => ({
            socket: ws, identity: { role, machineIds: new Set(['mac']), accountId: 'local:mac', transport: 'relay' },
            accountId: 'local:mac', role, machineIds: new Set(['mac']), connectedAt: Date.now(),
            ...(connectionId === undefined ? {} : { connectionId }),
        });
        const asking = socket();
        const other = socket();
        peers.add(peer('client', asking, 'conn-asking'));
        peers.add(peer('client', other, 'conn-other'));
        const replay = new ReplayLog(root, 10, 60_000);
        const header = { machineId: 'mac', senderId: 'mac', recipientId: '*', streamId: 'session-a', keyVersion: 1, at: Date.now() };
        const route = (seq: number, channel: 'attachment' | 'session', connectionId?: string) => routeEnvelope(
            { header: { ...header, seq, channel, ...(connectionId === undefined ? {} : { connectionId }) }, payload: 'e2ee:v2:opaque' },
            peer('machine', socket()), peers, new OfflineBuffer(root, 10, 60_000), replay,
            { pushWebhook: { url: 'http://127.0.0.1:9/', maxRetries: 0, timeoutMs: 1 } },
        );

        expect(route(1, 'attachment', 'conn-asking')).toEqual({ delivered: 1, buffered: false, pushNotified: false });
        expect(route(2, 'attachment', 'conn-gone')).toEqual({ delivered: 0, buffered: false, pushNotified: false });
        // A host from before directed chunks still broadcasts them; they stay out of the log too.
        expect(route(3, 'attachment').delivered).toBe(2);
        expect(route(4, 'session').delivered).toBe(2);
        expect(vi.mocked(asking.send)).toHaveBeenCalledTimes(3);
        expect(vi.mocked(other.send)).toHaveBeenCalledTimes(2);
        expect(replay.totalStored()).toBe(1);
    } finally {
        await awaitPersistChain();
        await rm(root, { recursive: true, force: true });
    }
});

it('hardens every relay state path in a custom data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-relay-state-'));
    const customDataDir = join(root, 'custom-data');
    const previousDataDir = process.env.MUXR_RELAY_DATA_DIR;
    process.env.MUXR_RELAY_DATA_DIR = customDataDir;
    const dataDir = loadRelayConfig().dataDir;
    const stateFiles = [
        'registry.json',
        'offline-buffer.json',
        'replay-log.json',
        'vapid.json',
        'push-subscriptions.json',
    ];
    const initial: Record<string, string> = {
        'registry.json': '{"accounts":{}}',
        'offline-buffer.json': '{"queues":{},"droppedCount":0}',
        'replay-log.json': '{"byMachine":{}}',
        'vapid.json': '{}',
        'push-subscriptions.json': JSON.stringify({
            accounts: {},
            deliveredEvents: [
                { accountId: 'tenant-b', eventId: 'event-keep', at: new Date().toISOString() },
                ...Array.from({ length: 2_049 }, (_, index) => ({ accountId: 'tenant-a', eventId: `event-${index}`, at: new Date().toISOString() })),
            ],
        }),
    };
    const previousUmask = process.umask(0o000);
    const originalHandles: FileHandle[] = [];

    try {
        expect(dataDir).toBe(customDataDir);
        await chmod(root, 0o755);
        await mkdir(dataDir, { mode: 0o755 });
        for (const name of stateFiles) {
            const filePath = join(dataDir, name);
            await writeFile(filePath, initial[name]!, { mode: 0o644 });
            await chmod(filePath, 0o644);
        }
        const originalInodes = new Map(await Promise.all(stateFiles.map(async (name) => {
            // Keep the old inode referenced until the assertion. Otherwise a
            // fast filesystem may legally recycle it after the atomic rename.
            const handle = await open(join(dataDir, name), 'r');
            originalHandles.push(handle);
            return [name, (await handle.stat()).ino] as const;
        })));

        const registry = new MachineRegistry(dataDir);
        const offline = new OfflineBuffer(dataDir, 10, 60_000);
        const replay = new ReplayLog(dataDir, 10, 60_000);
        const push = new PushService(dataDir);
        await registry.load();
        await offline.load();
        await replay.load();
        await push.load();

        const account = await registry.createAccount();

        const envelope: Envelope = {
            header: { machineId: 'machine-a', seq: 1, at: Date.now() },
            payload: 'opaque-ciphertext',
        };
        offline.enqueue('machine-a', envelope);
        replay.record('machine-a', 'toClient', envelope);
        await push.subscribe(account.accountId, {
            endpoint: 'https://push.example.com/subscription',
            keys: { p256dh: 'fixture-p256dh', auth: 'fixture-auth' },
        });
        await push.subscribeExpo(account.accountId, 'ExpoPushToken[fixture-token]');
        const expoAccount = await registry.createAccount();
        await push.subscribeExpo(expoAccount.accountId, 'ExpoPushToken[delivery-token]', 'all', 'device-1');
        let failNextExpoSend = false;
        const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
            if (failNextExpoSend) {
                failNextExpoSend = false;
                return new Response('', { status: 503 });
            }
            return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        const notification = parsePushNotification({
            eventId: 'event-done', kind: 'done', reasonCode: 'agent-done', agentName: 'Maria', taskTitle: 'Prepare release notes',
        });
        expect(notification).toEqual({
            eventId: 'event-done', kind: 'done', reasonCode: 'agent-done', agentName: 'Maria', taskTitle: 'Prepare release notes',
        });
        expect(parsePushNotification({
            eventId: 'event-unknown', kind: 'failed', reasonCode: 'unknown-prose', agentName: 'Maria',
        })).toBeUndefined();
        expect(parsePushNotification({
            eventId: 'event-private',
            kind: 'done',
            reasonCode: 'agent-done',
            agentName: 'Maria',
            taskTitle: '\u00a0/Users/owner/private/task',
        })).toBeUndefined();
        if (notification === undefined) throw new Error('fixture lifecycle notification rejected');
        const completed = {
            ...notification,
            sessionId: 'session-1', machineId: 'machine-a',
        };
        const concurrent = {
            ...completed, eventId: 'event-concurrent', kind: 'blocked' as const, reasonCode: 'agent-blocked' as const,
        };
        await expect(Promise.all([
            push.notify(expoAccount.accountId, completed),
            push.notify(expoAccount.accountId, concurrent),
        ])).resolves.toEqual([{ sent: 1 }, { sent: 1 }]);
        expect(fetchMock).toHaveBeenCalledWith('https://exp.host/--/api/v2/push/send', expect.objectContaining({ method: 'POST' }));
        const expoRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Array<Record<string, unknown>>;
        expect(expoRequest).toEqual([expect.objectContaining({
            title: 'Prepare release notes',
            body: 'Maria finished.',
            collapseId: 'event-done',
            data: expect.objectContaining({ eventId: 'event-done', kind: 'done', presentationOwner: 'relay-push' }),
        })]);
        await expect(push.notify(expoAccount.accountId, completed)).resolves.toEqual({ sent: 0, duplicate: true });

        const restartedPush = new PushService(dataDir);
        await restartedPush.load();
        await expect(restartedPush.notify(expoAccount.accountId, completed)).resolves.toEqual({ sent: 0, duplicate: true });
        await expect(restartedPush.notify(expoAccount.accountId, concurrent)).resolves.toEqual({ sent: 0, duplicate: true });
        await expect(restartedPush.notify('tenant-b', {
            ...completed, eventId: 'event-keep',
        })).resolves.toEqual({ sent: 0, duplicate: true });
        await expect(restartedPush.notify('tenant-a', {
            ...completed, eventId: 'event-0',
        })).resolves.toEqual({ sent: 0 });
        await expect(restartedPush.notify('tenant-a', {
            ...completed, eventId: 'event-2048',
        })).resolves.toEqual({ sent: 0, duplicate: true });

        const retryable = {
            ...completed, eventId: 'event-blocked', kind: 'blocked' as const, reasonCode: 'agent-blocked' as const,
        };
        failNextExpoSend = true;
        await expect(restartedPush.notify(expoAccount.accountId, retryable)).resolves.toEqual({ sent: 0 });
        await expect(restartedPush.notify(expoAccount.accountId, retryable)).resolves.toEqual({ sent: 1 });
        const startFailure = parsePushNotification({
            eventId: 'event-start-failed', kind: 'failed', reasonCode: 'start-timeout', agentName: 'John',
        });
        const runtimeFailure = parsePushNotification({
            eventId: 'event-runtime-failed', kind: 'failed', reasonCode: 'agent-runtime-failed', agentName: 'Maria',
        });
        if (startFailure === undefined || runtimeFailure === undefined) throw new Error('fixture failure notification rejected');
        await expect(restartedPush.notify(expoAccount.accountId, {
            ...startFailure, sessionId: 'session-2', machineId: 'machine-a',
        })).resolves.toEqual({ sent: 1 });
        await expect(restartedPush.notify(expoAccount.accountId, {
            ...runtimeFailure, sessionId: 'session-1', machineId: 'machine-a',
        })).resolves.toEqual({ sent: 1 });
        const failureRequests = fetchMock.mock.calls.slice(-2).map((call) =>
            (JSON.parse(String(call[1]?.body)) as Array<Record<string, unknown>>)[0]);
        expect(failureRequests).toEqual([
            expect.objectContaining({
                body: 'John could not start.',
                data: expect.objectContaining({ reasonCode: 'start-timeout' }),
            }),
            expect.objectContaining({
                body: 'Maria failed.',
                data: expect.objectContaining({ reasonCode: 'agent-runtime-failed' }),
            }),
        ]);
        await restartedPush.removeExpoDevice(expoAccount.accountId, 'device-1');
        await expect(restartedPush.notify(expoAccount.accountId, {
            ...completed, eventId: 'event-failed', kind: 'failed', reasonCode: 'agent-runtime-failed',
        })).resolves.toEqual({ sent: 0 });
        expect(fetchMock).toHaveBeenCalledTimes(6);
        vi.unstubAllGlobals();
        await awaitPersistChain();

        expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
        expect((await stat(root)).mode & 0o777).toBe(0o755);
        for (const name of stateFiles) {
            const info = await stat(join(dataDir, name));
            expect(info.mode & 0o777, name).toBe(0o600);
            expect(info.ino, `${name} atomic rewrite`).not.toBe(originalInodes.get(name));
        }
        expect((await readdir(dataDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

        const victimDirectory = join(root, 'user-directory');
        const linkedDataDir = join(root, 'linked-data');
        await mkdir(victimDirectory, { mode: 0o755 });
        await symlink(victimDirectory, linkedDataDir, 'dir');
        await expect(new MachineRegistry(linkedDataDir).load()).rejects.toThrow(/not a regular directory/);
        expect((await stat(victimDirectory)).mode & 0o777).toBe(0o755);

        const victimFile = join(root, 'user-file.json');
        const subscriptionsPath = join(dataDir, 'push-subscriptions.json');
        await writeFile(victimFile, 'untouched', { mode: 0o644 });
        await rm(subscriptionsPath);
        await symlink(victimFile, subscriptionsPath);
        await expect(push.subscribe(account.accountId, {
            endpoint: 'https://push.example.com/refused',
            keys: { p256dh: 'unused', auth: 'unused' },
        })).rejects.toThrow(/not a regular file/);
        expect(await readFile(victimFile, 'utf8')).toBe('untouched');
        expect((await stat(victimFile)).mode & 0o777).toBe(0o644);
    } finally {
        process.umask(previousUmask);
        if (previousDataDir === undefined) delete process.env.MUXR_RELAY_DATA_DIR;
        else process.env.MUXR_RELAY_DATA_DIR = previousDataDir;
        await Promise.all(originalHandles.map((handle) => handle.close()));
        await rm(root, { recursive: true, force: true });
    }
});

it('delivers frames sent while relay ticket authentication is pending without routing rejected peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-relay-auth-race-'));
    let releaseAuthorized!: () => void;
    let releaseRejected!: () => void;
    const authorizedGate = new Promise<void>((resolve) => { releaseAuthorized = resolve; });
    const rejectedGate = new Promise<void>((resolve) => { releaseRejected = resolve; });
    const relay = await startRelay({
        port: 0,
        host: '127.0.0.1',
        config: {
            dataDir: root,
            authMode: 'strict',
            e2eeMode: 'off',
            localAuthority: false,
            developmentApi: false,
            advertiseMdns: false,
        },
        consumeTicket: async (ticket) => {
            if (ticket === 'authorized-client') {
                await authorizedGate;
                return {
                    role: 'client',
                    machineSlug: 'target',
                    accountId: 'account',
                    transport: 'relay',
                };
            }
            if (ticket === 'rejected-client') {
                await rejectedGate;
                return undefined;
            }
            if (ticket === 'throwing-client') throw new Error('simulated authentication failure');
            return ticket === 'host'
                ? { role: 'machine', machineSlug: 'target', accountId: 'account', transport: 'relay' }
                : undefined;
        },
    });
    const sockets: WebSocket[] = [];
    try {
        const url = `ws://127.0.0.1:${relay.port}/relay`;
        const host = new WebSocket(`${url}?ticket=host`);
        sockets.push(host);
        await new Promise<void>((resolve, reject) => {
            host.once('open', resolve);
            host.once('error', reject);
        });
        await vi.waitFor(async () => {
            const response = await fetch(`http://127.0.0.1:${relay.port}/health`);
            await expect(response.json()).resolves.toMatchObject({ connectedPeers: 1 });
        });

        const received: string[] = [];
        host.on('message', (raw) => received.push(String(raw)));
        const envelope = JSON.stringify({
            header: { machineId: 'target', seq: 1, at: Date.now() },
            payload: 'opaque-ciphertext',
        });
        const authorized = new WebSocket(`${url}?ticket=authorized-client`);
        sockets.push(authorized);
        await new Promise<void>((resolve, reject) => {
            authorized.once('open', () => {
                authorized.send(envelope, (error) => {
                    if (error == null) resolve();
                    else reject(error);
                });
            });
            authorized.once('error', reject);
        });
        // Real WebSocket I/O cannot be advanced by fake timers; let the sent frame reach the gated server.
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(received).toEqual([]);
        releaseAuthorized();
        await vi.waitFor(() => expect(received).toHaveLength(2));
        const authorizedFrames = [...received];
        const [joined, routed] = authorizedFrames.map((frame) => JSON.parse(frame)) as [
            { type: string; connectionId: string }, Envelope,
        ];
        expect(joined).toEqual({ type: 'relay.client.joined', connectionId: expect.any(String) });
        expect(joined.connectionId).not.toBe('');
        const original = JSON.parse(envelope) as Envelope;
        expect(routed).toEqual({ ...original, header: { ...original.header, connectionId: joined.connectionId } });

        const rejected = new WebSocket(`${url}?ticket=rejected-client`);
        sockets.push(rejected);
        const rejectedClose = new Promise<number>((resolve, reject) => {
            rejected.once('open', () => rejected.send(envelope));
            rejected.once('close', resolve);
            rejected.once('error', reject);
        });
        await vi.waitFor(() => expect(rejected.readyState).toBe(WebSocket.OPEN));
        releaseRejected();
        await expect(rejectedClose).resolves.toBe(1008);
        expect(received).toEqual(authorizedFrames);

        const throwing = new WebSocket(`${url}?ticket=throwing-client`);
        sockets.push(throwing);
        const throwingClose = new Promise<number>((resolve, reject) => {
            throwing.once('close', resolve);
            throwing.once('error', reject);
        });
        await expect(throwingClose).resolves.toBe(1011);
        await vi.waitFor(async () => {
            const response = await fetch(`http://127.0.0.1:${relay.port}/health`);
            await expect(response.json()).resolves.toMatchObject({ connectedPeers: 2 });
        });
        expect(received).toEqual(authorizedFrames);
    } finally {
        for (const socket of sockets) socket.terminate();
        await relay.close();
        await rm(root, { recursive: true, force: true });
    }
});

it('keeps a throttled client throttled when many other addresses arrive through a trusted proxy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-relay-rate-limit-'));
    const relay = await startRelay({
        port: 0,
        host: '127.0.0.1',
        config: {
            dataDir: root,
            authMode: 'strict',
            e2eeMode: 'off',
            localAuthority: false,
            developmentApi: false,
            advertiseMdns: false,
            trustProxy: true,
        },
    });
    const status = async (ip: string): Promise<number> => {
        const response = await fetch(`http://127.0.0.1:${relay.port}/v1/nothing`, { headers: { 'x-forwarded-for': ip } });
        await response.arrayBuffer();
        return response.status;
    };
    const wsClose = (ip: string): Promise<string> => new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/relay`, { headers: { 'x-forwarded-for': ip } });
        socket.once('error', reject);
        socket.once('close', (_code, reason) => resolve(reason.toString()));
    });
    try {
        for (let i = 0; i < 300; i += 1) await status('203.0.113.7');
        expect(await status('203.0.113.7')).toBe(429);
        for (let i = 0; i < 60; i += 1) expect(await wsClose('203.0.113.8')).toBe('unauthorized');
        expect(await wsClose('203.0.113.8')).toBe('too many requests');
        let newcomerStatus = 0;
        for (let i = 0; i <= 10_000; i += 1) newcomerStatus = await status(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
        expect(newcomerStatus).toBe(429);
        expect(await status('203.0.113.7')).toBe(429);
        expect(await wsClose('203.0.113.8')).toBe('too many requests');
    } finally {
        await relay.close();
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
