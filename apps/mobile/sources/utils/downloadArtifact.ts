/**
 * Download an artifact — native implementation.
 *
 * Chunks land in a partial file under the cache directory, named by the
 * artifact's content id, so a later attempt resumes from the bytes already
 * there. The finished file keeps its display name for whatever opens it.
 *
 * Metro picks downloadArtifact.web.ts on web.
 */
import { File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { Platform } from 'react-native';
import { openWithSystem } from '@/../modules/artifact-open';
import { Modal } from '@/modal';
import { transferArtifact, type DownloadableArtifact, type TransferPlatform, type TransferSink } from '@/utils/artifactTransfer';

const DOWNLOADS = 'artifact-downloads';

function safeName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'artifact';
}

/** Content ids name their bytes; anything else is only trusted with its size. */
function downloadKey(artifact: DownloadableArtifact): string {
    return /^[0-9a-f]{64}$/.test(artifact.id) ? artifact.id : `${safeName(artifact.id)}-${artifact.size}`;
}

function partFile(artifact: DownloadableArtifact): File {
    return new File(Paths.cache, DOWNLOADS, `${downloadKey(artifact)}.part`);
}

/** Bytes an interrupted download left behind, e.g. before the app was closed. */
export function keptBytes(artifact: DownloadableArtifact): number {
    const part = partFile(artifact);
    return part.exists && part.size < artifact.size ? part.size : 0;
}

function sink(artifact: DownloadableArtifact): TransferSink {
    const key = downloadKey(artifact);
    const finished = new File(Paths.cache, DOWNLOADS, key, safeName(artifact.name));
    if (finished.exists && finished.size === artifact.size) {
        return { offset: artifact.size, write() {}, pause() {}, discard() {}, finish: () => finished.uri };
    }
    const part = partFile(artifact);
    if (part.exists && part.size > artifact.size) part.delete();
    if (!part.exists) part.create({ intermediates: true });
    const handle = part.open();
    // Append after whatever an interrupted attempt already wrote.
    handle.offset = handle.size ?? 0;
    return {
        offset: handle.offset ?? 0,
        write: (bytes) => handle.writeBytes(bytes),
        pause: () => handle.close(),
        discard: () => {
            handle.close();
            if (part.exists) part.delete();
        },
        finish: () => {
            handle.close();
            if (part.size !== artifact.size) throw new Error('The download was incomplete.');
            if (finished.exists) finished.delete();
            else finished.parentDirectory.create({ intermediates: true, idempotent: true });
            part.move(finished);
            return finished.uri;
        },
    };
}

function open(uri: string, artifact: DownloadableArtifact): void {
    // Android opens the file in place: the system installer for an APK, a
    // viewer for anything else it can show.
    if (Platform.OS === 'android' && openWithSystem(new File(uri).contentUri, artifact.mimeType)) return;
    // Share waits until the sheet is dismissed and can hang when nothing
    // handles APKs; never hold the download on it.
    const mime = artifact.mimeType === 'application/vnd.android.package-archive'
        ? 'application/octet-stream'
        : artifact.mimeType;
    void (async () => {
        if (!(await isAvailableAsync())) {
            Modal.alert('Saved', `"${artifact.name}" is on the phone, but sharing isn't available. Open it from Files.`);
            return;
        }
        try {
            await shareAsync(uri, { mimeType: mime, dialogTitle: artifact.name, UTI: artifact.mimeType });
        } catch {
            try {
                await shareAsync(uri, { mimeType: '*/*', dialogTitle: artifact.name });
            } catch {
                Modal.alert('Saved', `"${artifact.name}" is on the phone but nothing opened it. Try Files.`);
            }
        }
    })();
}

const platform: TransferPlatform = { sink, open };

export function downloadArtifact(sessionId: string, artifact: DownloadableArtifact): Promise<void> {
    return transferArtifact(sessionId, artifact, platform);
}
