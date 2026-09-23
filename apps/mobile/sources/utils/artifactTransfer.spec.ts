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

const appState = vi.hoisted(() => ({ currentState: 'active' }));
vi.mock('react-native', () => ({ AppState: appState, Platform: { OS: 'android' } }));
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
        useArtifactTransfers.setState({ [artifactTransferKey('session-'.repeat(5), long)]: { status: 'ready', total: long.size } }, true);
        pairing.stored = JSON.stringify({ mode: 'hosted', machineId: 'first', relayUrl: 'ws://127.0.0.1:8792', token: '', lastSessionCwd: '', recentSessionCwds: [] });
        const { loadConnectionSettingsAsync, saveConnectionSettings } = await import('@/connection/connectionSettings');
        await saveConnectionSettings({ ...await loadConnectionSettingsAsync(), machineId: 'second' });
        expect(existsSync(fresh)).toBe(false);
        expect(existsSync(join(dir, `${key}.part`))).toBe(false);
        expect(useArtifactTransfers.getState()).toEqual({});
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
        const earlier = new Date(artifact.at - 60_000);
        utimesSync(samePane, earlier, earlier);
        const same = (await watcher.scanPane('pane-1')).artifacts.find((item) => item.name === 'same-bytes.apk')!;
        expect((await watcher.read('pane-1', same.id, 0, 1))?.at).not.toBe(same.at);
        await transferArtifact('session-1', same, diskPlatform(opened));
        expect(opened).toContain(join(root, 'phone', 'same-bytes.apk'));
        expect(readFileSync(join(root, 'phone', 'same-bytes.apk')).equals(bytes)).toBe(true);

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

    it('keeps a hidden web download ready across reload until Save hands it to the browser', async () => {
        const files = new Map<string, { bytes: Uint8Array; modified: number }>();
        const directory = {
            async getFileHandle(name: string, options?: { create: boolean }) {
                if (!files.has(name)) {
                    if (!options?.create) throw new Error('Missing file');
                    files.set(name, { bytes: new Uint8Array(), modified: Date.now() });
                }
                return {
                    kind: 'file',
                    async getFile() {
                        const file = files.get(name)!;
                        return Object.assign(new Blob([file.bytes as Uint8Array<ArrayBuffer>]), { lastModified: file.modified });
                    },
                    async createWritable({ keepExistingData }: { keepExistingData: boolean }) {
                        let bytes = keepExistingData ? files.get(name)!.bytes : new Uint8Array();
                        let position = 0;
                        return {
                            async seek(offset: number) { position = offset; },
                            async write(chunk: Uint8Array) {
                                const next = new Uint8Array(Math.max(bytes.length, position + chunk.length));
                                next.set(bytes);
                                next.set(chunk, position);
                                bytes = next;
                                position += chunk.length;
                            },
                            async close() { files.set(name, { bytes, modified: Date.now() }); },
                            async abort() {},
                        };
                    },
                };
            },
            async removeEntry(name: string) { files.delete(name); },
            async *[Symbol.asyncIterator]() {
                for (const name of files.keys()) yield [name, await this.getFileHandle(name)];
            },
        };
        const clicks: Array<{ href: string; download: string }> = [];
        const document = {
            visibilityState: 'hidden',
            createElement: () => ({ href: '', download: '', click() { clicks.push({ href: this.href, download: this.download }); } }),
        };
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) } });
        vi.stubGlobal('document', document);
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        vi.useFakeTimers();
        try {
            appState.currentState = 'background';
            link.dropAfter = Infinity;
            link.requests.length = 0;
            const bytes = Buffer.from('the complete file remains private until Save');
            const artifact = { id: createHash('sha256').update(bytes).digest('hex'), name: 'ready.apk', size: bytes.length, at: Date.now(), mimeType: 'application/vnd.android.package-archive' };
            link.reader = async (_sessionId, id, offset, length) => {
                const chunk = bytes.subarray(offset, offset + length);
                return { id, size: bytes.length, at: artifact.at, offset, data: chunk.toString('base64'), sha256: createHash('sha256').update(chunk).digest('hex') };
            };
            const web = await import('./downloadArtifact.web');
            await web.downloadArtifact('session-ready', artifact);
            expect(useArtifactTransfers.getState()[artifactTransferKey('session-ready', artifact)]).toMatchObject({ status: 'ready' });
            expect(clicks).toHaveLength(0);
            expect(files.size).toBe(1);

            vi.resetModules();
            const reloaded = await import('./downloadArtifact.web');
            const state = await import('./artifactTransfer');
            await reloaded.sweepArtifactDownloads();
            expect(files.size).toBe(1);
            await reloaded.restoreReadyArtifact('session-ready', artifact);
            expect(state.useArtifactTransfers.getState()[state.artifactTransferKey('session-ready', artifact)]).toMatchObject({ status: 'ready' });
            const reads = link.requests.length;
            appState.currentState = 'active';
            document.visibilityState = 'visible';
            await reloaded.downloadArtifact('session-ready', artifact);
            expect(clicks).toEqual([{ href: 'blob:download', download: 'ready.apk' }]);
            // The browser's download manager still needs the private bytes after click().
            expect([...files.values()].some((file) => Buffer.from(file.bytes).equals(bytes))).toBe(true);
            expect(await reloaded.readyToSave('session-ready', artifact)).toBe(false);
            expect(link.requests).toHaveLength(reads);
            expect(state.useArtifactTransfers.getState()[state.artifactTransferKey('session-ready', artifact)]).toMatchObject({ status: 'done' });

            const race = { ...artifact, name: 'race.apk' };
            const initialReads = link.requests.length;
            const originalGet = directory.getFileHandle.bind(directory);
            let release!: () => void;
            const held = new Promise<void>((resolve) => { release = resolve; });
            let mark!: () => void;
            const marking = new Promise<void>((resolve) => { mark = resolve; });
            directory.getFileHandle = async (name, options) => {
                if (name.endsWith('.sent') && options?.create) { mark(); await held; }
                return originalGet(name, options);
            };
            const first = reloaded.downloadArtifact('session-ready', race);
            await marking;
            const second = reloaded.downloadArtifact('session-ready', race);
            release();
            await Promise.all([first, second]);
            directory.getFileHandle = originalGet;
            expect(clicks.filter((click) => click.download === 'race.apk')).toHaveLength(1);
            expect(link.requests.length - initialReads).toBe(1);
            expect([...files.values()].some((file) => Buffer.from(file.bytes).equals(bytes))).toBe(true);
            expect(await reloaded.readyToSave('session-ready', race)).toBe(false);
            vi.resetModules();
            const swept = await import('./downloadArtifact.web');
            await swept.sweepArtifactDownloads();
            expect(files.size).toBe(0);

            vi.resetModules();
            vi.stubGlobal('navigator', { storage: { getDirectory: async () => { throw new Error('No private storage'); } } });
            const memoryWeb = await import('./downloadArtifact.web');
            const memoryState = await import('./artifactTransfer');
            const memoryBytes = Buffer.from('memory-only download');
            const memoryArtifact = { ...artifact, id: createHash('sha256').update(memoryBytes).digest('hex'), name: 'memory.apk', size: memoryBytes.length };
            link.reader = async (_sessionId, id, offset, length) => {
                const chunk = memoryBytes.subarray(offset, offset + length);
                return { id, size: memoryBytes.length, at: memoryArtifact.at, offset, data: chunk.toString('base64'), sha256: createHash('sha256').update(chunk).digest('hex') };
            };
            appState.currentState = 'background';
            document.visibilityState = 'hidden';
            await memoryWeb.downloadArtifact('session-memory', memoryArtifact);
            expect(memoryState.useArtifactTransfers.getState()[memoryState.artifactTransferKey('session-memory', memoryArtifact)]).toMatchObject({ status: 'ready' });
            const memoryReads = link.requests.length;
            const beforeSave = clicks.length;
            appState.currentState = 'active';
            document.visibilityState = 'visible';
            await memoryWeb.downloadArtifact('session-memory', memoryArtifact);
            expect(clicks.slice(beforeSave)).toEqual([{ href: 'blob:download', download: 'memory.apk' }]);
            expect(link.requests).toHaveLength(memoryReads);
            expect(memoryState.useArtifactTransfers.getState()[memoryState.artifactTransferKey('session-memory', memoryArtifact)]).toMatchObject({ status: 'done' });

            appState.currentState = 'background';
            document.visibilityState = 'hidden';
            await memoryWeb.downloadArtifact('session-memory', memoryArtifact);
            vi.resetModules();
            const memoryReloaded = await import('./downloadArtifact.web');
            const memoryReloadState = await import('./artifactTransfer');
            await memoryReloaded.sweepArtifactDownloads();
            await memoryReloaded.restoreReadyArtifact('session-memory', memoryArtifact);
            expect(memoryReloadState.useArtifactTransfers.getState()[memoryReloadState.artifactTransferKey('session-memory', memoryArtifact)]).toBeUndefined();
            const beforeRedownload = link.requests.length;
            appState.currentState = 'active';
            document.visibilityState = 'visible';
            await memoryReloaded.downloadArtifact('session-memory', memoryArtifact);
            expect(link.requests.length).toBeGreaterThan(beforeRedownload);
            expect(memoryReloadState.useArtifactTransfers.getState()[memoryReloadState.artifactTransferKey('session-memory', memoryArtifact)]).toMatchObject({ status: 'done' });
        } finally {
            appState.currentState = 'active';
            vi.useRealTimers();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    });
});
