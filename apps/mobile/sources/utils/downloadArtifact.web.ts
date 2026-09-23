/**
 * Download an artifact — web implementation.
 *
 * Chunks land in the origin's private file system, one file per artifact
 * content id, so a dropped connection resumes from the bytes already written
 * and the page never holds the file in memory. The finished file goes to the
 * browser's own download manager. Metro picks downloadArtifact.ts on native.
 */
import { LARGE_FILE_ERROR, artifactTransferKey, transferArtifact, useArtifactTransfers, type DownloadableArtifact, type TransferPlatform, type TransferSink } from '@/utils/artifactTransfer';
import { sweepPartialDownloads } from '@/utils/artifactPartialRetention';
import { artifactDownloadKey } from '@/utils/artifactDownloadKey';

const MEMORY_LIMIT = 64 * 1024 * 1024;
const READY_SUFFIX = '.ready';
const DELIVERED_SUFFIX = '.sent';

function readyName(sessionId: string, artifact: DownloadableArtifact): string {
    return `${artifactDownloadKey(sessionId, artifact)}${READY_SUFFIX}`;
}

let downloads: Promise<FileSystemDirectoryHandle | undefined> | undefined;
const memoryReady = new Map<string, string>();

/**
 * Names carry the expected size, so a file already the right size is a
 * finished download. Those were handed to the browser in an earlier visit and
 * are cleared once per page; partial ones stay to be resumed.
 */
function downloadsDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
    downloads ??= (async () => {
        try {
            const root = await navigator.storage.getDirectory();
            const directory = await root.getDirectoryHandle('artifact-downloads', { create: true });
            await sweepDirectory(directory);
            return directory;
        } catch {
            return undefined;
        }
    })();
    return downloads;
}

async function sweepDirectory(directory: FileSystemDirectoryHandle, clear = false): Promise<void> {
    const entries: Array<[string, FileSystemHandle]> = [];
    for await (const entry of (directory as unknown as AsyncIterable<[string, FileSystemHandle]>)) entries.push(entry);
    const delivered = new Set(entries.filter(([name]) => name.endsWith(DELIVERED_SUFFIX)).map(([name]) => name.slice(0, -DELIVERED_SUFFIX.length)));
    const files = [];
    for (const [name, handle] of entries) {
        if (handle.kind !== 'file') continue;
        if (name.endsWith(DELIVERED_SUFFIX) || delivered.has(name)) {
            await directory.removeEntry(name);
            continue;
        }
        const file = await (handle as FileSystemFileHandle).getFile();
        const expected = Number(name.slice(name.lastIndexOf('-') + 1, name.endsWith(READY_SUFFIX) ? -READY_SUFFIX.length : undefined));
        if (!name.endsWith(READY_SUFFIX) && file.size === expected) await directory.removeEntry(name);
        else files.push({ modified: file.lastModified, remove: () => directory.removeEntry(name) });
    }
    await sweepPartialDownloads(files, clear);
}

export async function clearPartialDownloads(): Promise<void> {
    for (const uri of memoryReady.values()) URL.revokeObjectURL(uri);
    memoryReady.clear();
    const directory = await downloadsDirectory();
    if (directory !== undefined) await sweepDirectory(directory, true);
}

export async function sweepArtifactDownloads(): Promise<void> {
    await downloadsDirectory();
}

export async function readyToSave(sessionId: string, artifact: DownloadableArtifact): Promise<boolean> {
    const directory = await downloadsDirectory();
    if (directory === undefined) return false;
    const name = readyName(sessionId, artifact);
    try {
        await directory.getFileHandle(`${name}${DELIVERED_SUFFIX}`);
        return false;
    } catch {
        try {
            return (await (await directory.getFileHandle(name)).getFile()).size === artifact.size;
        } catch {
            return false;
        }
    }
}

export async function restoreReadyArtifact(sessionId: string, artifact: DownloadableArtifact): Promise<void> {
    if (!await readyToSave(sessionId, artifact)) return;
    const key = artifactTransferKey(sessionId, artifact);
    useArtifactTransfers.setState((all) => all[key] === undefined
        ? { ...all, [key]: { status: 'ready', total: artifact.size } }
        : all);
}

async function sink(artifact: DownloadableArtifact, sessionId: string): Promise<TransferSink> {
    const directory = await downloadsDirectory();
    if (directory === undefined) return fallbackSink(artifact, sessionId);
    const name = readyName(sessionId, artifact);
    let handle: FileSystemFileHandle;
    let kept: number;
    try {
        handle = await directory.getFileHandle(name, { create: true });
        kept = (await handle.getFile()).size;
        if (artifact.at === undefined && kept > 0) {
            await directory.removeEntry(name);
            handle = await directory.getFileHandle(name, { create: true });
            kept = 0;
        }
    } catch {
        return fallbackSink(artifact, sessionId);
    }
    if (kept === artifact.size) {
        return { offset: kept, write() {}, pause() {}, discard: () => directory.removeEntry(name), finish: () => name };
    }
    const offset = kept < artifact.size ? kept : 0;
    let writable: FileSystemWritableFileStream;
    try {
        writable = await handle.createWritable({ keepExistingData: offset > 0 });
        await writable.seek(offset);
    } catch {
        return fallbackSink(artifact, sessionId);
    }
    return {
        offset,
        write: (bytes) => writable.write(bytes as Uint8Array<ArrayBuffer>),
        pause: () => writable.close(),
        discard: async () => {
            try { await writable.abort(); } catch {}
            await directory.removeEntry(name);
        },
        finish: async () => {
            await writable.close();
            const file = await handle.getFile();
            if (file.size !== artifact.size) throw new Error('The download was incomplete.');
            return name;
        },
    };
}

function fallbackSink(artifact: DownloadableArtifact, sessionId: string): TransferSink {
    if (artifact.size > MEMORY_LIMIT) throw new Error(LARGE_FILE_ERROR);
    return memorySink(artifact, sessionId);
}

/** ponytail: below 64 MB, private windows and older Safari buffer Blob parts and resume from zero. */
function memorySink(artifact: DownloadableArtifact, sessionId: string): TransferSink {
    const parts: Blob[] = [];
    const key = artifactTransferKey(sessionId, artifact);
    return {
        offset: 0,
        write: (bytes) => { parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>])); },
        pause() {},
        discard: () => {
            parts.length = 0;
            const uri = memoryReady.get(key);
            if (uri !== undefined) URL.revokeObjectURL(uri);
            memoryReady.delete(key);
        },
        finish: () => {
            const uri = URL.createObjectURL(new Blob(parts, { type: artifact.mimeType }));
            memoryReady.set(key, uri);
            return uri;
        },
    };
}

async function open(uri: string, artifact: DownloadableArtifact, sessionId: string): Promise<void> {
    const stored = !uri.startsWith('blob:');
    const directory = stored ? await downloadsDirectory() : undefined;
    if (stored && directory === undefined) throw new Error('Saved file unavailable');
    const url = stored ? URL.createObjectURL(await (await directory!.getFileHandle(uri)).getFile()) : uri;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.name;
    if (stored) await directory!.getFileHandle(`${uri}${DELIVERED_SUFFIX}`, { create: true });
    try {
        anchor.click();
    } catch (error) {
        if (stored) await directory!.removeEntry(`${uri}${DELIVERED_SUFFIX}`);
        throw error;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (!stored) memoryReady.delete(artifactTransferKey(sessionId, artifact));
}

async function ready(artifact: DownloadableArtifact, sessionId: string): Promise<string | undefined> {
    const memory = memoryReady.get(artifactTransferKey(sessionId, artifact));
    if (memory !== undefined) return memory;
    return await readyToSave(sessionId, artifact) ? readyName(sessionId, artifact) : undefined;
}

const platform: TransferPlatform = { sink, open, ready, deliverBeforeDone: true };

export function downloadArtifact(sessionId: string, artifact: DownloadableArtifact): Promise<void> {
    return transferArtifact(sessionId, artifact, platform);
}
