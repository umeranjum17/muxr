/**
 * Download an attachment to the device — web implementation.
 *
 * Two paths:
 * - Blob already on the phone (inlined at emit time): instant object-URL
 *   anchor click.
 * - Blob too big to ever inline: a plain HTTPS GET on the relay's
 *   /v1/attachment-download. The browser's own download manager streams it —
 *   real progress bar, keeps going when the app is backgrounded, and the page
 *   never has to JSON-parse/decrypt hundreds of megabytes. Metro picks
 *   downloadAttachment.ts on native.
 */
import { blobObjectUrl } from '@/utils/attachmentBlobs';
import { attachmentDownloadUrl } from '@/utils/attachmentDownloadUrl';
import type { StoredSessionAttachment } from '@/catalog/application/persistence';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';

export type DownloadHandoff = 'browser' | 'device';

export async function downloadAttachment(sessionId: string, attachment: StoredSessionAttachment): Promise<DownloadHandoff> {
    if (getCachedConnectionSettings().mode !== 'local') {
        throw new Error('Web download needs a local (cleartext) relay. Use the native app for hosted files.');
    }
    if (attachment.localUri === undefined) {
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
