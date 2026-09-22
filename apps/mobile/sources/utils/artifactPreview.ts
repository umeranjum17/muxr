import { File, Paths } from 'expo-file-system';
import type { PluginAction } from '@muxr/contract';
import { decodeBase64 } from '@/encryption/base64';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';

export type ArtifactAction = Extract<PluginAction, { type: 'attachment' }>;
export type ArtifactPreviewSource = { uri: string; dispose?: () => void };

const CHUNK_BYTES = 512 * 1024;
const previewInflight = new Map<string, Promise<ArtifactPreviewSource>>();

function safeName(name: string): string {
    return (name.replace(/[^A-Za-z0-9._-]/g, '_') || 'image').slice(0, 64);
}

/** Materialize an image only when its thumbnail or gallery page mounts. */
export async function artifactPreview(sessionId: string, artifact: ArtifactAction): Promise<ArtifactPreviewSource> {
    const settings = getCachedConnectionSettings();
    const key = `${settings.machineId}\u0000${sessionId}\u0000${artifact.id}\u0000${artifact.size}`;
    const current = previewInflight.get(key);
    if (current !== undefined) return current;
    const pending = materializePreview(settings.machineId, sessionId, artifact);
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
    artifact: ArtifactAction,
): Promise<ArtifactPreviewSource> {
    // Content hashes are trusted only inside one machine/session namespace.
    // The filename ignores display name so renames reuse identical bytes.
    const contentAddressed = /^[0-9a-f]{64}$/.test(artifact.id);
    const base = contentAddressed
        ? `preview-${safeName(machineId)}-${safeName(sessionId)}-${artifact.id}`
        : `preview-${safeName(machineId)}-${safeName(sessionId)}-${safeName(artifact.id)}-${artifact.size}-${safeName(artifact.name)}`;
    const file = new File(Paths.cache, base);
    if (contentAddressed && file.exists && file.size === artifact.size) return { uri: file.uri };

    const temporary = new File(Paths.cache, `${base}.tmp`);
    if (temporary.exists) temporary.delete();
    temporary.create();
    try {
        const handle = temporary.open();
        try {
            let offset = 0;
            let artifactId = artifact.id;
            while (offset < artifact.size) {
                const chunk = await sync.artifactRead(sessionId, artifactId, offset, CHUNK_BYTES);
                if (chunk === null || chunk.offset !== offset || chunk.size !== artifact.size) throw new Error('Image changed during download');
                artifactId = chunk.id;
                const bytes = decodeBase64(chunk.data, 'base64');
                if (bytes.length === 0) throw new Error('Image download returned no data');
                handle.writeBytes(bytes);
                offset += bytes.length;
            }
        } finally {
            handle.close();
        }
        if (temporary.size !== artifact.size) throw new Error('Image download was incomplete');
        if (file.exists) file.delete();
        temporary.move(file);
        return { uri: file.uri };
    } catch (error) {
        if (temporary.exists) temporary.delete();
        throw error;
    }
}
