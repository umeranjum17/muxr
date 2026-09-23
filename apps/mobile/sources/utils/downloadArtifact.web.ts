/**
 * Download an artifact — web implementation.
 *
 * Chunks land in the origin's private file system, one file per artifact
 * content id, so a dropped connection resumes from the bytes already written
 * and the page never holds the file in memory. The finished file goes to the
 * browser's own download manager. Metro picks downloadArtifact.ts on native.
 */
import { LARGE_FILE_ERROR, transferArtifact, type DownloadableArtifact, type TransferPlatform, type TransferSink } from '@/utils/artifactTransfer';
import { sweepPartialDownloads } from '@/utils/artifactPartialRetention';
import { artifactDownloadKey } from '@/utils/artifactDownloadKey';

const MEMORY_LIMIT = 64 * 1024 * 1024;

let downloads: Promise<FileSystemDirectoryHandle | undefined> | undefined;

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
    const files = [];
    for await (const [name, handle] of (directory as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (handle.kind !== 'file') continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        const expected = Number(name.slice(name.lastIndexOf('-') + 1));
        if (file.size === expected) await directory.removeEntry(name);
        else files.push({ modified: file.lastModified, remove: () => directory.removeEntry(name) });
    }
    await sweepPartialDownloads(files, clear);
}

export async function clearPartialDownloads(): Promise<void> {
    const directory = await downloadsDirectory();
    if (directory !== undefined) await sweepDirectory(directory, true);
}

export async function sweepArtifactDownloads(): Promise<void> {
    await downloadsDirectory();
}

async function sink(artifact: DownloadableArtifact, sessionId: string): Promise<TransferSink> {
    const directory = await downloadsDirectory();
    if (directory === undefined) return fallbackSink(artifact);
    const name = artifactDownloadKey(sessionId, artifact);
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
        return fallbackSink(artifact);
    }
    if (kept === artifact.size) {
        return { offset: kept, write() {}, pause() {}, discard: () => directory.removeEntry(name), finish: async () => URL.createObjectURL(await handle.getFile()) };
    }
    const offset = kept < artifact.size ? kept : 0;
    let writable: FileSystemWritableFileStream;
    try {
        writable = await handle.createWritable({ keepExistingData: offset > 0 });
        await writable.seek(offset);
    } catch {
        return fallbackSink(artifact);
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
            return URL.createObjectURL(file);
        },
    };
}

function fallbackSink(artifact: DownloadableArtifact): TransferSink {
    if (artifact.size > MEMORY_LIMIT) throw new Error(LARGE_FILE_ERROR);
    return memorySink(artifact);
}

/** ponytail: below 64 MB, private windows and older Safari buffer Blob parts and resume from zero. */
function memorySink(artifact: DownloadableArtifact): TransferSink {
    const parts: Blob[] = [];
    return {
        offset: 0,
        write: (bytes) => { parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>])); },
        pause() {},
        discard: () => { parts.length = 0; },
        finish: () => URL.createObjectURL(new Blob(parts, { type: artifact.mimeType })),
    };
}

function open(uri: string, artifact: DownloadableArtifact): void {
    const anchor = document.createElement('a');
    anchor.href = uri;
    anchor.download = artifact.name;
    anchor.click();
    // The browser resolves the URL when the download starts; give a large
    // file time to be copied out before letting go of it.
    setTimeout(() => URL.revokeObjectURL(uri), 60_000);
}

const platform: TransferPlatform = { sink, open };

export function downloadArtifact(sessionId: string, artifact: DownloadableArtifact): Promise<void> {
    return transferArtifact(sessionId, artifact, platform);
}
