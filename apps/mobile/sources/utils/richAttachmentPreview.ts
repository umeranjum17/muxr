import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { AttachmentAction } from './attachmentPreview';

export type RichPreviewKind = 'markdown' | 'pdf' | 'csv' | 'xlsx' | 'html' | 'svg' | 'text';
export function richPreviewKind(name: string): RichPreviewKind | null {
    const extension = name.toLowerCase().split('.').pop();
    if (extension === 'md' || extension === 'markdown') return 'markdown';
    if (extension === 'htm' || extension === 'html') return 'html';
    if (extension === 'pdf' || extension === 'csv' || extension === 'xlsx' || extension === 'svg') return extension;
    if (['txt', 'log', 'json', 'yaml', 'yml', 'xml'].includes(extension ?? '')) return 'text';
    return null;
}

/** One bounded read, through the same authenticated transport as attachments. */
export async function readRichAttachment(sessionId: string, attachment: AttachmentAction, signal: AbortSignal): Promise<{ kind: RichPreviewKind; base64: string }> {
    const kind = richPreviewKind(attachment.name);
    const limit = kind === 'pdf' || kind === 'xlsx' ? 8 * 1024 * 1024 : 256 * 1024;
    if (kind === null || !Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > limit) throw new Error('This file exceeds the preview limit. Download it to view the original.');
    const machine = getCachedConnectionSettings().machineId;
    const deadline = Date.now() + 25000;
    const bytes = new Uint8Array(attachment.size);
    let offset = 0, attachmentId = attachment.id;
    const assertCurrent = () => {
        if (signal.aborted || machine !== getCachedConnectionSettings().machineId) throw new Error('Preview closed or connection changed.');
        if (Date.now() >= deadline) throw new Error('Preview download timed out.');
    };
    assertCurrent();
    while (offset < bytes.length) {
        assertCurrent();
        const length = Math.min(256 * 1024, bytes.length - offset);
        const chunk = await sync.request('attachment.read', { sessionId, attachmentId, offset, length }, Math.max(1, deadline - Date.now()));
        assertCurrent();
        if (!chunk || chunk.offset !== offset || chunk.size !== bytes.length) throw new Error('Attachment changed during preview.');
        const data = decodeBase64(chunk.data, 'base64');
        if (!data.length || data.length > length) throw new Error('Invalid attachment chunk.');
        bytes.set(data, offset); offset += data.length; attachmentId = chunk.id;
    }
    return { kind, base64: encodeBase64(bytes) };
}
