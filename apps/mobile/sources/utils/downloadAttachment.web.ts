/**
 * Download an attachment to the device — web implementation.
 *
 * Three paths (Metro picks downloadAttachment.ts on native):
 * - Blob already on the phone (inlined at emit time): instant object-URL
 *   anchor click.
 * - Local/cleartext relay: a plain HTTPS GET on the relay's
 *   /v1/attachment-download. The browser's own download manager streams it —
 *   real progress bar, keeps going when the app is backgrounded, and the page
 *   never has to JSON-parse/decrypt hundreds of megabytes.
 * - Hosted/E2EE: the existing attachment.read chunk path. File System Access
 *   API streams chunks straight to disk where available; otherwise a bounded
 *   in-memory Blob fallback with a clear ceiling for very large files.
 */
import { blobObjectUrl } from '@/utils/attachmentBlobs';
import { attachmentDownloadUrl } from '@/utils/attachmentDownloadUrl';
import type { StoredSessionAttachment } from '@/catalog/application/persistence';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { decodeBase64 } from '@/encryption/base64';

export type DownloadHandoff = 'browser' | 'device' | 'cancelled';

/** Same chunk size as the native hosted path. */
const CHUNK_LENGTH = 512 * 1024;
/** Transient relay hiccups must not kill a large download outright. */
const CHUNK_ATTEMPTS = 3;
/**
 * Blob-fallback ceiling: without filesystem streaming the whole file sits on
 * the JS heap plus a base64 copy in flight. Above this, say so plainly.
 */
const BLOB_FALLBACK_CEILING = 128 * 1024 * 1024;

interface FileSystemWritable {
    write: (data: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
}

interface FileSystemFileHandle {
    createWritable: () => Promise<FileSystemWritable>;
}

function saveFilePicker(): undefined | ((options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>) {
    if (typeof window === 'undefined') return undefined;
    const picker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    if (typeof picker !== 'function') return undefined;
    const bound = picker as (this: Window, options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
    // Call with the Window receiver: extracting the WebIDL method loses it
    // and Chrome throws Illegal invocation.
    return (options?: { suggestedName?: string }) => bound.call(window, options);
}

async function readChunk(sessionId: string, attachmentId: string, offset: number): Promise<{ id: string; size: number; bytes: Uint8Array }> {
    let failed: unknown = undefined;
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
        try {
            const chunk = await sync.request('attachment.read', {
                sessionId,
                attachmentId,
                offset,
                length: CHUNK_LENGTH,
            }, 60_000);
            if (chunk === null || chunk.offset !== offset) {
                throw new Error('attachment changed or disappeared during download');
            }
            const bytes = decodeBase64(chunk.data, 'base64');
            if (bytes.length === 0) throw new Error('attachment download returned an empty chunk');
            return { id: chunk.id, size: chunk.size, bytes };
        } catch (error) {
            failed = error;
            // Changed-file mismatches are deterministic; only the transport
            // itself is worth retrying.
            if (error instanceof Error && /changed or disappeared|empty chunk/.test(error.message)) throw error;
            if (attempt < CHUNK_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
    }
    throw failed instanceof Error ? failed : new Error('attachment download failed');
}

/** Hosted/E2EE: stream chunks straight to disk, nothing retained on the heap. */
async function streamHostedFile(sessionId: string, attachment: StoredSessionAttachment): Promise<DownloadHandoff> {
    const pick = saveFilePicker();
    if (pick === undefined) return blobHostedFile(sessionId, attachment);
    let handle: FileSystemFileHandle;
    try {
        handle = await pick({ suggestedName: attachment.name });
    } catch (error) {
        // Dismissing the save dialog is a cancel, not a failure: resolve
        // quietly so no Download failed modal follows.
        if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
        throw error;
    }
    const writable = await handle.createWritable();
    try {
        let offset = 0;
        let attachmentId = attachment.id;
        while (offset < attachment.size) {
            const chunk = await readChunk(sessionId, attachmentId, offset);
            if (chunk.size !== attachment.size) throw new Error('attachment changed or disappeared during download');
            attachmentId = chunk.id;
            await writable.write(chunk.bytes);
            offset += chunk.bytes.length;
        }
        await writable.close();
        return 'device';
    } catch (cause) {
        try {
            await writable.abort();
        } catch {
            // The original failure already explains the outcome.
        }
        throw cause;
    }
}

/** Hosted/E2EE without filesystem streaming: bounded in-memory Blob. */
async function blobHostedFile(sessionId: string, attachment: StoredSessionAttachment): Promise<DownloadHandoff> {
    if (attachment.size > BLOB_FALLBACK_CEILING) {
        throw new Error(`"${attachment.name}" is too large to download in this browser (${Math.round(attachment.size / 1024 / 1024)} MB). Use the native app, where downloads stream to disk.`);
    }
    const parts: Uint8Array[] = [];
    let offset = 0;
    let attachmentId = attachment.id;
    while (offset < attachment.size) {
        const chunk = await readChunk(sessionId, attachmentId, offset);
        if (chunk.size !== attachment.size) throw new Error('attachment changed or disappeared during download');
        attachmentId = chunk.id;
        parts.push(chunk.bytes);
        offset += chunk.bytes.length;
    }
    const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: attachment.mimeType }));
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = attachment.name;
        anchor.click();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return 'device';
}

export async function downloadAttachment(sessionId: string, attachment: StoredSessionAttachment): Promise<DownloadHandoff> {
    if (attachment.localUri !== undefined) {
        const url = await blobObjectUrl(attachment.id);
        if (url === null) throw new Error(`Could not read "${attachment.name}" from the browser cache.`);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = attachment.name;
        anchor.click();
        return 'device';
    }
    if (getCachedConnectionSettings().mode === 'local') {
        const ready = await sync.request('attachment.prepare', { sessionId, attachmentId: attachment.id });
        if (ready === null) {
            throw new Error(`"${attachment.name}" is no longer on the host — it was replaced since this list arrived.`);
        }
        const anchor = document.createElement('a');
        anchor.href = attachmentDownloadUrl(sessionId, attachment);
        anchor.download = attachment.name;
        anchor.click();
        return 'browser';
    }
    return streamHostedFile(sessionId, attachment);
}
