import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory model of expo-file-system's cache directory with the real API
// contract that matters here: create() refuses to overwrite an existing name.
const cacheFiles = new Map<string, Uint8Array[]>();
const deletedNames: string[] = [];

vi.mock('expo-file-system', () => ({
    Paths: { cache: { uri: 'file:///cache' } },
    File: class {
        name: string;
        constructor(_dir: unknown, name: string) {
            this.name = name;
        }
        get exists(): boolean {
            return cacheFiles.has(this.name);
        }
        get uri(): string {
            return `file:///cache/${this.name}`;
        }
        create(): void {
            if (cacheFiles.has(this.name)) throw new Error(`File '${this.name}' already exists`);
            cacheFiles.set(this.name, []);
        }
        delete(): void {
            cacheFiles.delete(this.name);
            deletedNames.push(this.name);
        }
        open() {
            return {
                writeBytes: (bytes: Uint8Array): void => {
                    const parts = cacheFiles.get(this.name);
                    if (parts === undefined) throw new Error(`${this.name} vanished under the handle`);
                    parts.push(bytes);
                },
                close(): void {},
            };
        }
    },
}));

const shareUris: string[] = [];
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => true,
    shareAsync: async (uri: string) => {
        shareUris.push(uri);
    },
}));

const { pending, request } = vi.hoisted(() => {
    const pending = new Map<string, Promise<unknown>>();
    const request = async (_method: string, params: { sessionId: string; artifactId: string; offset: number; length?: number }, _timeoutMs?: number) => {
        if (pending.has(params.artifactId)) await pending.get(params.artifactId);
        const payload = params.artifactId === 'a1' ? 'hello' : 'world';
        return { id: params.artifactId, offset: params.offset, size: payload.length, data: Buffer.from(payload).toString('base64') };
    };
    return { pending, request };
});
// The app calls the typed artifact wire; these specs stand in for the
// transport under it, so the stub answers the canonical names directly.
vi.mock('@/catalog/sync', () => ({
    sync: {
        request,
        artifactRead: (sessionId: string, artifactId: string, offset: number, length: number, timeoutMs?: number) =>
            request('artifact.read', { sessionId, artifactId, offset, length }, timeoutMs),
    },
}));

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => ({ mode: 'hosted' as const, machineId: 'm1' }),
}));
vi.mock('@/modal', () => ({ Modal: { alert: () => {} } }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: async () => {} }));

import { downloadArtifact } from './downloadArtifact';

function cachedBytes(name: string): string {
    return Buffer.concat((cacheFiles.get(name) ?? []).map((part) => Buffer.from(part))).toString();
}

describe('downloadArtifact cache names', () => {
    beforeEach(() => {
        cacheFiles.clear();
        deletedNames.length = 0;
        shareUris.length = 0;
        pending.clear();
    });

    it('keeps the bare display name when free and suffixes a colliding concurrent download', async () => {
        const first = { id: 'a1', name: 'report.md', mimeType: 'text/plain', size: 5, at: 1 };
        const second = { id: 'a2', name: 'report.md', mimeType: 'text/plain', size: 5, at: 2 };
        // Suspend the first download after it reserved its cache name.
        let releaseFirst: () => void = () => {};
        pending.set('a1', new Promise<void>((resolve) => { releaseFirst = resolve; }));

        const firstDownload = downloadArtifact('session-a', { ...first });
        await vi.waitFor(() => expect(cacheFiles.has('report.md')).toBe(true));
        await downloadArtifact('session-b', { ...second });
        releaseFirst();
        const firstHandoff = await firstDownload;

        expect(firstHandoff).toBe('device');
        expect(deletedNames).toEqual([]);
        expect(cachedBytes('report.md')).toBe('hello');
        expect(cachedBytes('report-2.md')).toBe('world');
        await vi.waitFor(() => expect(shareUris).toHaveLength(2));
        expect([...shareUris].sort()).toEqual(['file:///cache/report-2.md', 'file:///cache/report.md']);
    });
});
