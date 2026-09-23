/**
 * Download an artifact — web implementation.
 *
 * Chunks land in the origin's private file system, one file per artifact
 * content id, so a dropped connection resumes from the bytes already written
 * and the page never holds the file in memory. The finished file goes to the
 * browser's own download manager. Metro picks downloadArtifact.ts on native.
 */
import { transferArtifact, type DownloadableArtifact, type TransferPlatform, type TransferSink } from '@/utils/artifactTransfer';

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
            for await (const [name, handle] of (directory as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
                if (handle.kind !== 'file') continue;
                const expected = Number(name.slice(name.lastIndexOf('-') + 1));
                if ((await (handle as FileSystemFileHandle).getFile()).size === expected) await directory.removeEntry(name);
            }
            return directory;
        } catch {
            return undefined;
        }
    })();
    return downloads;
}

function fileName(artifact: DownloadableArtifact): string {
    const id = /^[0-9a-f]{64}$/.test(artifact.id) ? artifact.id : artifact.id.replace(/[^A-Za-z0-9._]/g, '_');
    return `${id}-${artifact.size}`;
}

async function sink(artifact: DownloadableArtifact): Promise<TransferSink> {
    const directory = await downloadsDirectory();
    if (directory === undefined) return memorySink(artifact);
    const name = fileName(artifact);
    const handle = await directory.getFileHandle(name, { create: true });
    const kept = (await handle.getFile()).size;
    if (kept === artifact.size) {
        return { offset: kept, write() {}, pause() {}, discard() {}, finish: async () => URL.createObjectURL(await handle.getFile()) };
    }
    const offset = kept < artifact.size ? kept : 0;
    const writable = await handle.createWritable({ keepExistingData: offset > 0 });
    await writable.seek(offset);
    return {
        offset,
        write: (bytes) => writable.write(bytes as Uint8Array<ArrayBuffer>),
        pause: () => writable.close(),
        discard: async () => {
            await writable.abort();
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

/** ponytail: without a private file system (private windows, older Safari) bytes sit in Blob parts and a resume starts over. */
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

/** The private file system answers asynchronously; a kept partial shows once the download resumes. */
export function keptBytes(_artifact: DownloadableArtifact): number {
    return 0;
}

export function downloadArtifact(sessionId: string, artifact: DownloadableArtifact): Promise<void> {
    return transferArtifact(sessionId, artifact, platform);
}
