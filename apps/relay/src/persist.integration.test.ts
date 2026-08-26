import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Envelope } from '@muxr/contract';
import { OfflineBuffer } from './buffer.js';
import { loadRelayConfig } from './config.js';
import { awaitPersistChain } from './persist.js';
import { PushService } from './push.js';
import { MachineRegistry } from './registry.js';
import { ReplayLog } from './replay.js';
import { SelfhostPairing } from './selfhostPairing.js';
import { PeerTable, type ConnectedPeer } from './peers.js';
import { routeEnvelope, type PeerRouteOutcome } from './routing.js';

it('keeps a browser grant recoverable until its role and durable client acknowledgement are confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxr-browser-pairing-'));
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
            expiresAt: Date.now() + 60_000,
        });
        expect(claimed.state).toBe('issued');
        if (claimed.state !== 'issued') return;
        expect(await pairing.poll(session.pairId, 'machine-a')).toMatchObject({ state: 'claimed', authority: 'control', acknowledged: false });
        await expect(pairing.uploadGrant(session.pairId, 'machine-a', 'sealed-grant')).resolves.toBe(true);
        await expect(pairing.fetchGrant(session.pairId, claimed.deviceId)).resolves.toBe('sealed-grant');
        await expect(pairing.fetchGrant(session.pairId, claimed.deviceId)).resolves.toBe('sealed-grant');
        await expect(pairing.acknowledgeGrant(session.pairId, claimed.deviceId)).resolves.toBe(true);
        expect(await pairing.poll(session.pairId, 'machine-a')).toMatchObject({ acknowledged: true });
    } finally {
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
            socket, identity: { kind: 'ticket', role: 'machine', machineIds: new Set(['mac']), accountId: 'local:mac', transport: 'relay' },
            accountId: 'local:mac', role: 'machine', machineIds: new Set(['mac']), connectedAt: Date.now(),
        };
        const source: ConnectedPeer = {
            socket: { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as import('ws').WebSocket,
            identity: {
                kind: 'ticket', role: 'client', machineIds: new Set(['mac']), accountId: 'local:linux',
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
                kind: 'ticket', role: 'client', machineIds: new Set(['mac']), accountId: 'local:mac',
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
        'push-subscriptions.json': '{"accounts":{}}',
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
            endpoint: 'https://push.test/subscription',
            keys: { p256dh: 'fixture-p256dh', auth: 'fixture-auth' },
        });
        await push.subscribeExpo(account.accountId, 'ExpoPushToken[fixture-token]');
        const expoAccount = await registry.createAccount();
        await push.subscribeExpo(expoAccount.accountId, 'ExpoPushToken[delivery-token]', 'device-1');
        const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(push.notify(expoAccount.accountId, {
            title: 'Agent finished', body: 'Agent finished', sessionId: 'session-1', machineId: 'machine-a',
        })).resolves.toEqual({ sent: 1 });
        expect(fetchMock).toHaveBeenCalledWith('https://exp.host/--/api/v2/push/send', expect.objectContaining({ method: 'POST' }));
        const expoRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Array<{ title: string; body: string }>;
        expect(expoRequest).toEqual([expect.objectContaining({ title: 'muxr', body: 'An agent needs your attention.' })]);
        await push.removeExpoDevice(expoAccount.accountId, 'device-1');
        await expect(push.notify(expoAccount.accountId, {
            title: 'Should not send', body: 'Should not send', sessionId: 'session-1', machineId: 'machine-a',
        })).resolves.toEqual({ sent: 0 });
        expect(fetchMock).toHaveBeenCalledOnce();
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
            endpoint: 'https://push.test/refused',
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
