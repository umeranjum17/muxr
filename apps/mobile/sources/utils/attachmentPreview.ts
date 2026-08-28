import { File, Paths } from 'expo-file-system';
import type { PluginAction } from '@muxr/contract';
import { decodeBase64 } from '@/encryption/base64';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { sync } from '@/sync/sync';
import { attachmentDownloadUrl } from '@/utils/attachmentDownloadUrl';

export type AttachmentAction = Extract<PluginAction, { type: 'attachment' }>;
export type AttachmentPreviewSource = { uri: string; dispose?: () => void };

const CHUNK_BYTES = 512 * 1024;

function safeName(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]/g, '_') || 'image';
}

/** Materialize an image only when its thumbnail or gallery page mounts. */
export async function attachmentPreview(sessionId: string, attachment: AttachmentAction): Promise<AttachmentPreviewSource> {
    if (getCachedConnectionSettings().mode === 'local') {
        // The image GET performs the one authoritative prepare. Preflighting it
        // here doubled host work for every thumbnail in the sheet.
        return { uri: attachmentDownloadUrl(sessionId, { ...attachment, mimeType: attachment.mimeType ?? 'application/octet-stream', at: 0 }) };
    }

    const file = new File(Paths.cache, `preview-${safeName(attachment.id)}-${safeName(attachment.name)}`);
    // Small attachments are content-addressed; large ones use their name, so a
    // same-size replacement must not inherit yesterday's cached pixels.
    const contentAddressed = /^[0-9a-f]{64}$/.test(attachment.id);
    if (contentAddressed && file.exists && file.size === attachment.size) return { uri: file.uri };
    if (file.exists) file.delete();
    file.create();
    const handle = file.open();
    try {
        let offset = 0;
        let attachmentId = attachment.id;
        while (offset < attachment.size) {
            const chunk = await sync.request('attachment.read', { sessionId, attachmentId, offset, length: CHUNK_BYTES }, 60_000);
            if (chunk === null || chunk.offset !== offset || chunk.size !== attachment.size) throw new Error('Image changed during download');
            attachmentId = chunk.id;
            const bytes = decodeBase64(chunk.data, 'base64');
            if (bytes.length === 0) throw new Error('Image download returned no data');
            handle.writeBytes(bytes);
            offset += bytes.length;
        }
    } finally {
        handle.close();
    }
    return { uri: file.uri };
}
