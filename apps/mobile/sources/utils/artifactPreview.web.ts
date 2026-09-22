import type { PluginAction } from '@muxr/contract';
import { decodeBase64 } from '@/encryption/base64';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';

export type ArtifactAction = Extract<PluginAction, { type: 'attachment' }>;
export type ArtifactPreviewSource = { uri: string; dispose?: () => void };

const CHUNK_BYTES = 512 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const previewInflight = new Map<string, Promise<Blob>>();

/** Web materializes one bounded, visible preview through authenticated chunks. */
export async function artifactPreview(sessionId: string, artifact: ArtifactAction): Promise<ArtifactPreviewSource> {
    const settings = getCachedConnectionSettings();
    if (artifact.size > MAX_PREVIEW_BYTES) throw new Error('Image is too large to preview in the browser');
    const key = `${settings.machineId}\u0000${sessionId}\u0000${artifact.id}\u0000${artifact.size}`;
    let pending = previewInflight.get(key);
    if (pending === undefined) {
        pending = downloadPreviewBlob(sessionId, artifact);
        previewInflight.set(key, pending);
        const owner = pending;
        void owner.then(
            () => { if (previewInflight.get(key) === owner) previewInflight.delete(key); },
            () => { if (previewInflight.get(key) === owner) previewInflight.delete(key); },
        );
    }
    const blob = await pending;
    const uri = URL.createObjectURL(blob);
    return { uri, dispose: () => URL.revokeObjectURL(uri) };
}

async function downloadPreviewBlob(sessionId: string, artifact: ArtifactAction): Promise<Blob> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let artifactId = artifact.id;
    while (offset < artifact.size) {
        const chunk = await sync.artifactRead(sessionId, artifactId, offset, CHUNK_BYTES, 60_000);
        if (chunk === null || chunk.offset !== offset || chunk.size !== artifact.size) throw new Error('Image changed during download');
        artifactId = chunk.id;
        const bytes = decodeBase64(chunk.data, 'base64');
        if (bytes.length === 0 || offset + bytes.length > artifact.size) throw new Error('Image download returned invalid data');
        chunks.push(bytes);
        offset += bytes.length;
    }
    return new Blob(chunks as BlobPart[], { type: artifact.mimeType ?? 'application/octet-stream' });
}
