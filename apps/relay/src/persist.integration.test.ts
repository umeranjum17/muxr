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
