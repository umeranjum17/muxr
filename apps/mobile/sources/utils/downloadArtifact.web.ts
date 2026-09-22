/**
 * Download an artifact to the device — web implementation.
 *
 * Cached blobs download immediately; small metadata-only artifacts use bounded
 * authenticated chunks; large local files hand off to the relay's streaming
 * endpoint so the page never retains hundreds of megabytes. Metro picks
 * downloadArtifact.ts on native.
 */
import { blobObjectUrl } from '@/utils/artifactBlobs';
import { artifactDownloadUrl } from '@/utils/artifactDownloadUrl';
import type { StoredSessionArtifact } from '@/catalog/application/persistence';
import { getCachedConnectionSettings } from '@/connection';
import { decodeBase64 } from '@/encryption/base64';
import { sync } from '@/catalog/sync';

export type DownloadHandoff = 'browser' | 'device';

const MAX_IN_APP_BYTES = 2 * 1024 * 1024;

async function downloadSmallFile(sessionId: string, artifact: StoredSessionArtifact): Promise<void> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let artifactId = artifact.id;
    while (offset < artifact.size) {
        const chunk = await sync.artifactRead(sessionId, artifactId, offset, 512 * 1024, 60_000);
        if (chunk === null || chunk.offset !== offset || chunk.size !== artifact.size) throw new Error('Artifact changed during download.');
        const bytes = decodeBase64(chunk.data);
        if (bytes.length === 0 || offset + bytes.length > artifact.size) throw new Error('Artifact download returned invalid data.');
        chunks.push(bytes);
        offset += bytes.length;
        artifactId = chunk.id;
    }
    const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: artifact.mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadArtifact(sessionId: string, artifact: StoredSessionArtifact): Promise<DownloadHandoff> {
    if (getCachedConnectionSettings().mode !== 'local') {
        throw new Error('Web download needs a local (cleartext) relay. Use the native app for hosted files.');
    }
    if (artifact.localUri === undefined) {
        if (artifact.size <= MAX_IN_APP_BYTES) {
            await downloadSmallFile(sessionId, artifact);
            return 'browser';
        }
        const ready = await sync.artifactPrepare(sessionId, artifact.id);
        if (ready === null) {
            throw new Error(`"${artifact.name}" is no longer on the host — it was replaced since this list arrived.`);
        }
        const anchor = document.createElement('a');
        anchor.href = artifactDownloadUrl(sessionId, artifact);
        anchor.download = artifact.name;
        anchor.click();
        return 'browser';
    }
    const url = await blobObjectUrl(artifact.id);
    if (url === null) throw new Error(`Could not read "${artifact.name}" from the browser cache.`);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.name;
    anchor.click();
    return 'device';
}
