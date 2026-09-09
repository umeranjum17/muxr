import type { PluginAction } from '@muxr/contract';
import { decodeBase64 } from '@/encryption/base64';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { attachmentDownloadUrl } from '@/utils/attachmentDownloadUrl';

export type AttachmentAction = Extract<PluginAction, { type: 'attachment' }>;
export type AttachmentPreviewSource = { uri: string; dispose?: () => void };

const CHUNK_BYTES = 512 * 1024;
const MAX_HOSTED_PREVIEW_BYTES = 8 * 1024 * 1024;
const hostedPreviewInflight = new Map<string, Promise<Blob>>();

/** Web uses the relay directly when local and a bounded object URL when hosted. */
export async function attachmentPreview(sessionId: string, attachment: AttachmentAction): Promise<AttachmentPreviewSource> {
    const settings = getCachedConnectionSettings();
    if (settings.mode === 'local') {
        return { uri: attachmentDownloadUrl(sessionId, { ...attachment, mimeType: attachment.mimeType ?? 'application/octet-stream', at: 0 }) };
    }

    if (attachment.size > MAX_HOSTED_PREVIEW_BYTES) throw new Error('Image is too large to preview in the browser');
    const key = `${settings.machineId}\u0000${sessionId}\u0000${attachment.id}\u0000${attachment.size}`;
    let pending = hostedPreviewInflight.get(key);
    if (pending === undefined) {
        pending = downloadHostedBlob(sessionId, attachment);
        hostedPreviewInflight.set(key, pending);
        const owner = pending;
        void owner.then(
            () => { if (hostedPreviewInflight.get(key) === owner) hostedPreviewInflight.delete(key); },
            () => { if (hostedPreviewInflight.get(key) === owner) hostedPreviewInflight.delete(key); },
        );
    }
    const blob = await pending;
    const uri = URL.createObjectURL(blob);
    return { uri, dispose: () => URL.revokeObjectURL(uri) };
}

async function downloadHostedBlob(sessionId: string, attachment: AttachmentAction): Promise<Blob> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let attachmentId = attachment.id;
    while (offset < attachment.size) {
        const chunk = await sync.request('attachment.read', { sessionId, attachmentId, offset, length: CHUNK_BYTES }, 60_000);
        if (chunk === null || chunk.offset !== offset || chunk.size !== attachment.size) throw new Error('Image changed during download');
        attachmentId = chunk.id;
        const bytes = decodeBase64(chunk.data, 'base64');
        if (bytes.length === 0 || offset + bytes.length > attachment.size) throw new Error('Image download returned invalid data');
        chunks.push(bytes);
        offset += bytes.length;
    }
    return new Blob(chunks as BlobPart[], { type: attachment.mimeType ?? 'application/octet-stream' });
}
