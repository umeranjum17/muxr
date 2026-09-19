import { File, Paths } from 'expo-file-system';
import type { PluginAction } from '@muxr/contract';
import { decodeBase64 } from '@/encryption/base64';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';

export type AttachmentAction = Extract<PluginAction, { type: 'attachment' }>;
export type AttachmentPreviewSource = { uri: string; dispose?: () => void };

const CHUNK_BYTES = 512 * 1024;
const previewInflight = new Map<string, Promise<AttachmentPreviewSource>>();

function safeName(name: string): string {
    return (name.replace(/[^A-Za-z0-9._-]/g, '_') || 'image').slice(0, 64);
}

/** Materialize an image only when its thumbnail or gallery page mounts. */
export async function attachmentPreview(sessionId: string, attachment: AttachmentAction): Promise<AttachmentPreviewSource> {
    const settings = getCachedConnectionSettings();
    const key = `${settings.machineId}\u0000${sessionId}\u0000${attachment.id}\u0000${attachment.size}`;
    const current = previewInflight.get(key);
    if (current !== undefined) return current;
    const pending = materializePreview(settings.machineId, sessionId, attachment);
    previewInflight.set(key, pending);
    void pending.then(
        () => { if (previewInflight.get(key) === pending) previewInflight.delete(key); },
        () => { if (previewInflight.get(key) === pending) previewInflight.delete(key); },
    );
    return pending;
}

async function materializePreview(
    machineId: string,
    sessionId: string,
    attachment: AttachmentAction,
): Promise<AttachmentPreviewSource> {
    // Content hashes are trusted only inside one machine/session namespace.
    // The filename ignores display name so renames reuse identical bytes.
    const contentAddressed = /^[0-9a-f]{64}$/.test(attachment.id);
    const base = contentAddressed
        ? `preview-${safeName(machineId)}-${safeName(sessionId)}-${attachment.id}`
        : `preview-${safeName(machineId)}-${safeName(sessionId)}-${safeName(attachment.id)}-${attachment.size}-${safeName(attachment.name)}`;
    const file = new File(Paths.cache, base);
    if (contentAddressed && file.exists && file.size === attachment.size) return { uri: file.uri };

    const temporary = new File(Paths.cache, `${base}.tmp`);
    if (temporary.exists) temporary.delete();
    temporary.create();
    try {
        const handle = temporary.open();
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
        if (temporary.size !== attachment.size) throw new Error('Image download was incomplete');
        if (file.exists) file.delete();
        temporary.move(file);
        return { uri: file.uri };
    } catch (error) {
        if (temporary.exists) temporary.delete();
        throw error;
    }
}
