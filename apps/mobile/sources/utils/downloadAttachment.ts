/**
 * Download an attachment — native implementation.
 *
 * Local/cleartext streams large files through the system browser. Hosted/E2EE
 * writes bounded encrypted chunks directly to a device file, so no giant blob
 * or JSON frame is retained on the JavaScript heap.
 *
 * Metro picks downloadAttachment.web.ts on web.
 */
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { attachmentDownloadUrl } from '@/utils/attachmentDownloadUrl';
import type { StoredSessionAttachment } from '@/catalog/application/persistence';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { decodeBase64 } from '@/encryption/base64';
import { File, Paths } from 'expo-file-system';
import { Modal } from '@/modal';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { attachmentKind } from '@/utils/attachmentKind';

export type DownloadHandoff = 'browser' | 'device';

/** Same cap as host `MAX_FETCH_BYTES`: bigger than this never rides the JS thread. */
const MAX_IN_APP_BYTES = 2 * 1024 * 1024;

function tooHeavyForApp(attachment: StoredSessionAttachment): boolean {
    return attachment.size > MAX_IN_APP_BYTES || attachmentKind(attachment.name, attachment.mimeType) === 'apk';
}

function safeName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'attachment';
}

async function writeHostedFile(sessionId: string, attachment: StoredSessionAttachment): Promise<string> {
    const file = new File(Paths.cache, `${safeName(attachment.id)}-${safeName(attachment.name)}`);
    if (file.exists) file.delete();
    file.create();
    const handle = file.open();
    try {
        let offset = 0;
        let attachmentId = attachment.id;
        while (offset < attachment.size) {
            const chunk = await sync.request('attachment.read', {
                sessionId,
                attachmentId,
                offset,
                length: 512 * 1024,
            }, 60_000);
            if (chunk === null || chunk.offset !== offset || chunk.size !== attachment.size) {
                throw new Error('attachment changed or disappeared during download');
            }
            attachmentId = chunk.id;
            const bytes = decodeBase64(chunk.data, 'base64');
            if (bytes.length === 0) throw new Error('attachment download returned an empty chunk');
            handle.writeBytes(bytes);
            offset += bytes.length;
        }
    } finally {
        handle.close();
    }
    return file.uri;
}

function handoffToOs(uri: string, attachment: StoredSessionAttachment): void {
    // Share waits until the sheet is dismissed and can hang when nothing
    // handles APKs. Do not block the download spinner on it.
    const mime = attachment.mimeType === 'application/vnd.android.package-archive'
        ? 'application/octet-stream'
        : attachment.mimeType;
    void (async () => {
        if (!(await isAvailableAsync())) {
            Modal.alert('Saved', `"${attachment.name}" is on the phone, but sharing isn't available. Open it from Files.`);
            return;
        }
        try {
            await shareAsync(uri, { mimeType: mime, dialogTitle: attachment.name, UTI: attachment.mimeType });
        } catch {
            try {
                await shareAsync(uri, { mimeType: '*/*', dialogTitle: attachment.name });
            } catch {
                Modal.alert('Saved', `"${attachment.name}" is on the phone but nothing opened it. Try Files.`);
            }
        }
    })();
}

async function openInBrowser(sessionId: string, attachment: StoredSessionAttachment): Promise<DownloadHandoff> {
    const ready = await sync.request('attachment.prepare', { sessionId, attachmentId: attachment.id });
    if (ready === null) {
        throw new Error(`"${attachment.name}" is no longer on the host — it was replaced since this list arrived.`);
    }
    await openExternalUrl(attachmentDownloadUrl(sessionId, attachment));
    return 'browser';
}

export async function downloadAttachment(sessionId: string, attachment: StoredSessionAttachment): Promise<DownloadHandoff> {
    const local = getCachedConnectionSettings().mode === 'local';
    if (local && (tooHeavyForApp(attachment) || attachment.localUri === undefined)) {
        return openInBrowser(sessionId, attachment);
    }
    if (attachment.localUri === undefined) {
        const uri = await writeHostedFile(sessionId, attachment);
        handoffToOs(uri, attachment);
        return 'device';
    }
    handoffToOs(attachment.localUri, attachment);
    return 'device';
}
