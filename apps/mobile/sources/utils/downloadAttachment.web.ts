/**
 * Download an attachment to the device — web implementation.
 *
 * Cached blobs download immediately; small metadata-only artifacts use bounded
 * authenticated chunks; large local files hand off to the relay's streaming
 * endpoint so the page never retains hundreds of megabytes. Metro picks
 * downloadAttachment.ts on native.
 */
import { blobObjectUrl } from '@/utils/attachmentBlobs';
import { attachmentDownloadUrl } from '@/utils/attachmentDownloadUrl';
import type { StoredSessionAttachment } from '@/catalog/application/persistence';
import { getCachedConnectionSettings } from '@/connection';
import { decodeBase64 } from '@/encryption/base64';
import { sync } from '@/catalog/sync';

export type DownloadHandoff = 'browser' | 'device';

const MAX_IN_APP_BYTES = 2 * 1024 * 1024;

async function downloadSmallFile(sessionId: string, attachment: StoredSessionAttachment): Promise<void> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let attachmentId = attachment.id;
    while (offset < attachment.size) {
        const chunk = await sync.request('attachment.read', { sessionId, attachmentId, offset, length: 512 * 1024 }, 60_000);
        if (chunk === null || chunk.offset !== offset || chunk.size !== attachment.size) throw new Error('Attachment changed during download.');
        const bytes = decodeBase64(chunk.data);
        if (bytes.length === 0 || offset + bytes.length > attachment.size) throw new Error('Attachment download returned invalid data.');
        chunks.push(bytes);
        offset += bytes.length;
        attachmentId = chunk.id;
    }
    const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: attachment.mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = attachment.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadAttachment(sessionId: string, attachment: StoredSessionAttachment): Promise<DownloadHandoff> {
    if (getCachedConnectionSettings().mode !== 'local') {
        throw new Error('Web download needs a local (cleartext) relay. Use the native app for hosted files.');
    }
    if (attachment.localUri === undefined) {
        if (attachment.size <= MAX_IN_APP_BYTES) {
            await downloadSmallFile(sessionId, attachment);
            return 'browser';
        }
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
    const url = await blobObjectUrl(attachment.id);
    if (url === null) throw new Error(`Could not read "${attachment.name}" from the browser cache.`);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = attachment.name;
    anchor.click();
    return 'device';
}
