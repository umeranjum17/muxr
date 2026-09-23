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
    reader: undefined as undefined | ((artifactId: string, offset: number, length: number) => Promise<unknown>),
    requests: [] as Array<{ offset: number; length: number }>,
    dropAfter: Infinity,
    pending: [] as Array<(error: Error) => void>,
}));
const connection = vi.hoisted(() => ({ store: undefined as unknown as { setState: (state: { socketStatus: string }) => void } }));

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('@/catalog/store', async () => {
    const { create: createStore } = await import('zustand');
    const storage = createStore(() => ({ socketStatus: 'connected' }));
    connection.store = storage;
    return { storage };
});
vi.mock('@/catalog/sync', () => ({
    sync: {
        artifactRead: (_sessionId: string, artifactId: string, offset: number, length: number) => {
            link.requests.push({ offset, length });
            if (link.requests.length > link.dropAfter) {
                // Everything in flight dies with the socket.
                return new Promise((_, reject) => link.pending.push(reject));
            }
            return link.reader!(artifactId, offset, length);
        },
    },
}));

import { transferArtifact, useArtifactTransfers, type TransferPlatform, type TransferSink } from './artifactTransfer';
import { sweepPartialDownloads } from './artifactPartialRetention';

const root = mkdtempSync(join(tmpdir(), 'muxr-transfer-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The native sink's contract on a plain directory: append to a partial, move when whole. */
function diskPlatform(opened: string[]): TransferPlatform {
    const dir = join(root, 'phone');
    mkdirSync(dir, { recursive: true });
    return {
        sink(artifact): TransferSink {
            const part = join(dir, `${artifact.id}.part`);
            const finished = join(dir, artifact.name);
            if (!existsSync(part)) writeFileSync(part, '');
            const fd = openSync(part, 'a');
            return {
                offset: statSync(part).size,
                write: (bytes) => { writeSync(fd, bytes); },
                pause: () => closeSync(fd),
                discard: () => closeSync(fd),
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
        const dir = join(root, 'retention');
        mkdirSync(dir);
        const old = join(dir, 'old.part');
        const fresh = join(dir, 'fresh.part');
        writeFileSync(old, 'old bytes');
        writeFileSync(fresh, 'fresh bytes');
        const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
        utimesSync(old, nineDaysAgo, nineDaysAgo);
        const entries = () => [old, fresh].filter(existsSync).map((path) => ({
            modified: statSync(path).mtimeMs, remove: () => rmSync(path),
        }));
        await sweepPartialDownloads(entries());
        expect(existsSync(old)).toBe(false);
        expect(readFileSync(fresh, 'utf8')).toBe('fresh bytes');
        await sweepPartialDownloads(entries(), true);
        expect(existsSync(fresh)).toBe(false);
    });

    it('streams bounded chunks to disk and resumes from the kept bytes after the connection drops', async () => {
        const paneDir = join(root, 'host', 'pane-1');
        mkdirSync(paneDir, { recursive: true });
        const bytes = randomBytes(7 * 512 * 1024 + 12_345);
        writeFileSync(join(paneDir, 'release.apk'), bytes);
        const id = createHash('sha256').update(bytes).digest('hex');
        const watcher = new ArtifactWatcher(join(root, 'host'), () => undefined);
        link.reader = (artifactId, offset, length) => watcher.read('pane-1', artifactId, offset, length);
        link.dropAfter = 3;
        const opened: string[] = [];
        const artifact = { id, name: 'release.apk', mimeType: 'application/vnd.android.package-archive', size: bytes.length };

        const done = transferArtifact('session-1', artifact, diskPlatform(opened));

        // Three chunks land, the fourth request never answers, and the socket goes.
        await vi.waitFor(() => expect(link.pending.length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(useArtifactTransfers.getState()[id]).toMatchObject({ status: 'downloading', received: 3 * 512 * 1024 }));
        connection.store.setState({ socketStatus: 'disconnected' });
        for (const reject of link.pending.splice(0)) reject(new Error('connection lost'));
        await vi.waitFor(() => expect(useArtifactTransfers.getState()[id]).toEqual({ status: 'waiting', received: 3 * 512 * 1024, total: bytes.length }));
        expect(statSync(join(root, 'phone', `${id}.part`)).size).toBe(3 * 512 * 1024);

        // Reconnect: the download picks up at the first byte it does not have.
        const beforeResume = link.requests.length;
        link.dropAfter = Infinity;
        connection.store.setState({ socketStatus: 'connected' });
        await done;

        expect(link.requests[beforeResume]).toEqual({ offset: 3 * 512 * 1024, length: 512 * 1024 });
        expect(link.requests.every(({ length }) => length <= 512 * 1024)).toBe(true);
        expect(useArtifactTransfers.getState()[id]).toEqual({ status: 'done', total: bytes.length });
        expect(opened).toEqual([join(root, 'phone', 'release.apk')]);
        expect(readFileSync(opened[0]!).equals(bytes)).toBe(true);
    });
});
