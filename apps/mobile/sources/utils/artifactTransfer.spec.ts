import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { ArtifactWatcher } from '../../../host/src/agent/infrastructure/artifactWatcher';

// The phone's side of the link: the host's own chunk reader answers every
// artifact.read, and the test can drop the connection under it the way a
// relay restart or a backgrounded phone does.
const link = vi.hoisted(() => ({
    reader: undefined as undefined | ((sessionId: string, artifactId: string, offset: number, length: number) => Promise<unknown>),
    requests: [] as Array<{ offset: number; length: number }>,
    dropAfter: Infinity,
    pending: [] as Array<(error: Error) => void>,
}));
const connection = vi.hoisted(() => ({ store: undefined as unknown as { setState: (state: { socketStatus: string }) => void } }));
const fsRead = vi.hoisted(() => ({ block: false, pending: [] as Array<() => void> }));
vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return { ...original, open: async (...args: Parameters<typeof original.open>) => {
        if (fsRead.block && String(args[0]).endsWith('/changed.apk')) await new Promise<void>((resolve) => fsRead.pending.push(resolve));
        return original.open(...args);
    } };
});

vi.mock('react-native', () => ({ AppState: { currentState: 'active' }, Platform: { OS: 'android' } }));
vi.mock('@/catalog/store', async () => {
    const { create: createStore } = await import('zustand');
    const storage = createStore(() => ({ socketStatus: 'connected' }));
    connection.store = storage;
    return { storage };
});
vi.mock('@/catalog/sync', () => ({
    sync: {
        artifactRead: (sessionId: string, artifactId: string, offset: number, length: number) => {
            link.requests.push({ offset, length });
            if (link.requests.length > link.dropAfter) {
                // Everything in flight dies with the socket.
                return new Promise((_, reject) => link.pending.push(reject));
            }
            return link.reader!(sessionId, artifactId, offset, length);
        },
    },
}));

vi.mock('expo-crypto', async () => {
    const { createHash } = await import('node:crypto');
    return {
        CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
        digest: async (_algorithm: string, bytes: Uint8Array) => createHash('sha256').update(bytes).digest(),
    };
});
const pairing = vi.hoisted(() => ({ stored: null as string | null, cache: '' }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async () => pairing.stored,
    setItem: async (_key: string, value: string) => { pairing.stored = value; },
} }));
vi.mock('@/pairing/secrets', () => ({ getWebSecret: async () => null, setWebSecret: async () => undefined }));
vi.mock('expo-file-system', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    class File {
        readonly path: string;
        constructor(...parts: string[]) { this.path = path.join(...parts); }
        get name() { return path.basename(this.path); }
        get exists() { return fs.existsSync(this.path); }
        get modificationTime() { return fs.statSync(this.path).mtimeMs; }
        get size() { return fs.statSync(this.path).size; }
        delete() { fs.rmSync(this.path); }
    }
    class Directory {
        readonly path: string;
        constructor(...parts: string[]) { this.path = path.join(...parts); }
        get exists() { return fs.existsSync(this.path); }
        list() { return fs.readdirSync(this.path).map((name) => new File(this.path, name)); }
    }
    return { File, Directory, Paths: { get cache() { return pairing.cache; } } };
});
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => false, shareAsync: async () => undefined }));
vi.mock('@/../modules/artifact-open', () => ({ openWithSystem: () => false }));
vi.mock('@/modal', () => ({ Modal: { alert: () => undefined } }));

import { artifactTransferKey, transferArtifact, useArtifactTransfers, type TransferPlatform, type TransferSink } from './artifactTransfer';
import { artifactDownloadKey } from './artifactDownloadKey';

const root = mkdtempSync(join(tmpdir(), 'muxr-transfer-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The native sink's contract on a plain directory: append to a partial, move when whole. */
function diskPlatform(opened: string[]): TransferPlatform {
    const dir = join(root, 'phone');
    mkdirSync(dir, { recursive: true });
    return {
        sink(artifact, sessionId): TransferSink {
            const part = join(dir, `${sessionId}-${artifact.id}-${artifact.name}-${artifact.size}-${artifact.at ?? 'unknown'}.part`);
            const finished = join(dir, artifact.name);
            if (!existsSync(part)) writeFileSync(part, '');
            const fd = openSync(part, 'a');
            return {
                offset: statSync(part).size,
                write: (bytes) => { writeSync(fd, bytes); },
                pause: () => closeSync(fd),
                discard: () => { closeSync(fd); rmSync(part, { force: true }); },
                finish: () => {
                    closeSync(fd);
                    renameSync(part, finished);
                    return finished;
                },
            };
        },
        open: (uri) => { opened.push(uri); },
    };
}

describe('progressive artifact download', () => {
    it('retains fresh partials at startup and clears them when pairing changes', async () => {
        pairing.cache = join(root, 'retention');
        const dir = join(pairing.cache, 'artifact-downloads');
        mkdirSync(dir, { recursive: true });
        const old = join(dir, 'old.part');
        const fresh = join(dir, 'fresh.part');
        writeFileSync(old, 'old bytes');
        writeFileSync(fresh, 'fresh bytes');
        const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
        utimesSync(old, nineDaysAgo, nineDaysAgo);
        const { keptBytes, sweepArtifactDownloads } = await import('@/utils/downloadArtifact');
        await sweepArtifactDownloads();
        expect(existsSync(old)).toBe(false);
        expect(readFileSync(fresh, 'utf8')).toBe('fresh bytes');
        const long = { id: 'a'.repeat(64), name: `${'release-'.repeat(20)}.apk`, size: 100, at: Date.now() };
        const key = artifactDownloadKey('session-'.repeat(5), long);
        writeFileSync(join(dir, `${key}.part`), 'kept');
        expect(keptBytes('session-'.repeat(5), { ...long, mimeType: 'application/vnd.android.package-archive' })).toBe(4);
        expect(key).not.toBe(artifactDownloadKey('session-'.repeat(5), { ...long, name: `${'release-'.repeat(20)}-other.apk` }));
        pairing.stored = JSON.stringify({ mode: 'hosted', machineId: 'first', relayUrl: 'ws://127.0.0.1:8792', token: '', lastSessionCwd: '', recentSessionCwds: [] });
        const { loadConnectionSettingsAsync, saveConnectionSettings } = await import('@/connection/connectionSettings');
        await saveConnectionSettings({ ...await loadConnectionSettingsAsync(), machineId: 'second' });
        expect(existsSync(fresh)).toBe(false);
        expect(existsSync(join(dir, `${key}.part`))).toBe(false);
    });

    it('streams bounded chunks to disk and resumes from the kept bytes after the connection drops', async () => {
        const paneDir = join(root, 'host', 'pane-1');
        mkdirSync(paneDir, { recursive: true });
        const bytes = randomBytes(7 * 512 * 1024 + 12_345);
        writeFileSync(join(paneDir, 'release.apk'), bytes);
        const id = createHash('sha256').update(bytes).digest('hex');
        const watcher = new ArtifactWatcher(join(root, 'host'), () => undefined);
        link.reader = (_sessionId, artifactId, offset, length) => watcher.read('pane-1', artifactId, offset, length);
        link.dropAfter = 3;
        const opened: string[] = [];
        const artifact = { id, name: 'release.apk', mimeType: 'application/vnd.android.package-archive', size: bytes.length, at: (await watcher.scanPane('pane-1')).artifacts[0]!.at };

        const done = transferArtifact('session-1', artifact, diskPlatform(opened));

        // Three chunks land, the fourth request never answers, and the socket goes.
        await vi.waitFor(() => expect(link.pending.length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(useArtifactTransfers.getState()[artifactTransferKey('session-1', artifact)]).toMatchObject({ status: 'downloading', received: 3 * 512 * 1024 }));
        connection.store.setState({ socketStatus: 'disconnected' });
        for (const reject of link.pending.splice(0)) reject(new Error('connection lost'));
        await vi.waitFor(() => expect(useArtifactTransfers.getState()[artifactTransferKey('session-1', artifact)]).toEqual({ status: 'waiting', received: 3 * 512 * 1024, total: bytes.length }));
        expect(statSync(join(root, 'phone', `session-1-${id}-${artifact.name}-${bytes.length}-${artifact.at}.part`)).size).toBe(3 * 512 * 1024);

        // Reconnect: the download picks up at the first byte it does not have.
        const beforeResume = link.requests.length;
        link.dropAfter = Infinity;
        connection.store.setState({ socketStatus: 'connected' });
        await done;

        expect(link.requests[beforeResume]).toEqual({ offset: 0, length: 512 * 1024 });
        expect(link.requests[beforeResume + 1]).toEqual({ offset: 3 * 512 * 1024, length: 512 * 1024 });
        expect(link.requests.every(({ length }) => length <= 512 * 1024)).toBe(true);
        expect(useArtifactTransfers.getState()[artifactTransferKey('session-1', artifact)]).toEqual({ status: 'done', total: bytes.length });
        expect(opened).toEqual([join(root, 'phone', 'release.apk')]);
        expect(readFileSync(opened[0]!).equals(bytes)).toBe(true);

        for (const [pane, name] of [['pane-2', 'copy.apk'], ['pane-3', 'mirror.apk']]) {
            const other = join(root, 'host', pane);
            mkdirSync(other);
            writeFileSync(join(other, name), bytes);
        }
        const copy = { ...artifact, name: 'copy.apk', at: (await watcher.scanPane('pane-2')).artifacts[0]!.at };
        const mirror = { ...artifact, name: 'mirror.apk', at: (await watcher.scanPane('pane-3')).artifacts[0]!.at };
        link.reader = (sessionId, artifactId, offset, length) => watcher.read(sessionId === 'session-2' ? 'pane-2' : 'pane-3', artifactId, offset, length);
        await Promise.all([
            transferArtifact('session-2', copy, diskPlatform(opened)),
            transferArtifact('session-3', mirror, diskPlatform(opened)),
        ]);
        expect(useArtifactTransfers.getState()[artifactTransferKey('session-2', copy)]).toMatchObject({ status: 'done' });
        expect(useArtifactTransfers.getState()[artifactTransferKey('session-3', mirror)]).toMatchObject({ status: 'done' });
        expect(new Set(opened)).toEqual(new Set(['release.apk', 'copy.apk', 'mirror.apk'].map((name) => join(root, 'phone', name))));
        expect(['copy.apk', 'mirror.apk'].every((name) => readFileSync(join(root, 'phone', name)).equals(bytes))).toBe(true);
        link.reader = (_sessionId, artifactId, offset, length) => watcher.read('pane-1', artifactId, offset, length);
        const samePane = join(paneDir, 'same-bytes.apk');
        writeFileSync(samePane, bytes);
        const later = new Date(Date.now() + 60_000);
        utimesSync(samePane, later, later);
        await transferArtifact('session-1', artifact, diskPlatform(opened));
        expect(opened.filter((uri) => uri === join(root, 'phone', 'release.apk'))).toHaveLength(2);
        expect(readFileSync(join(root, 'phone', 'release.apk')).equals(bytes)).toBe(true);

        const changedPath = join(paneDir, 'changed.apk');
        const oldBytes = randomBytes(3 * 512 * 1024);
        writeFileSync(changedPath, oldBytes);
        const changedId = createHash('sha256').update(oldBytes).digest('hex');
        const changed = { ...artifact, id: changedId, name: 'changed.apk', size: oldBytes.length, at: (await watcher.scanPane('pane-1')).artifacts.find((item) => item.id === changedId)!.at };
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        link.reader = async (_sessionId, artifactId, offset, length) => {
            if (offset > 0) await held;
            return watcher.read('pane-1', artifactId, offset, length);
        };
        link.requests.length = 0;
        const interrupted = transferArtifact('session-1', changed, diskPlatform(opened));
        await vi.waitFor(() => expect(useArtifactTransfers.getState()[artifactTransferKey('session-1', changed)]).toMatchObject({ received: 512 * 1024 }));
        const nextPath = join(paneDir, 'changed.next');
        writeFileSync(nextPath, randomBytes(oldBytes.length));
        fsRead.block = true;
        release();
        await vi.waitFor(() => expect(fsRead.pending).toHaveLength(2));
        renameSync(nextPath, changedPath);
        fsRead.block = false;
        for (const resume of fsRead.pending.splice(0)) resume();
        await expect(interrupted).rejects.toThrow('Changed on the computer');
        expect(existsSync(join(root, 'phone', `session-1-${changedId}-${changed.name}-${changed.size}-${changed.at}.part`))).toBe(false);
        expect(opened).toHaveLength(4);

        const corruptPath = join(paneDir, 'corrupt.apk');
        const correct = randomBytes(2 * 512 * 1024);
        writeFileSync(corruptPath, correct);
        const corruptId = createHash('sha256').update(correct).digest('hex');
        const corrupt = { ...artifact, id: corruptId, name: 'corrupt.apk', size: correct.length, at: (await watcher.scanPane('pane-1')).artifacts.find((item) => item.id === corruptId)!.at };
        link.requests.length = 0;
        link.reader = async (_sessionId, artifactId, offset, length) => {
            const chunk = await watcher.read('pane-1', artifactId, offset, length);
            return chunk && offset === 0 ? { ...chunk, data: randomBytes(length).toString('base64') } : chunk;
        };
        await expect(transferArtifact('session-1', corrupt, diskPlatform(opened))).rejects.toThrow('integrity check');
        expect(link.requests.filter((request) => request.offset === 0)).toHaveLength(2);
        expect(useArtifactTransfers.getState()[artifactTransferKey('session-1', corrupt)]).toMatchObject({ status: 'failed', message: 'Download failed integrity check. Try again.' });
        expect(opened).toHaveLength(4);
    });
});
