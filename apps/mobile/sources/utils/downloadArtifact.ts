/**
 * Download an artifact — native implementation.
 *
 * Chunks land in a partial file under the cache directory, named by the
 * artifact's content id, so a later attempt resumes from the bytes already
 * there. The finished file keeps its display name for whatever opens it.
 *
 * Metro picks downloadArtifact.web.ts on web.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { Platform } from 'react-native';
import { openWithSystem } from '@/../modules/artifact-open';
import { Modal } from '@/modal';
import { transferArtifact, type DownloadableArtifact, type TransferPlatform, type TransferSink } from '@/utils/artifactTransfer';
import { sweepPartialDownloads } from '@/utils/artifactPartialRetention';
import { artifactDownloadKey } from '@/utils/artifactDownloadKey';

const DOWNLOADS = 'artifact-downloads';

async function sweepDownloads(clear = false): Promise<void> {
    const directory = new Directory(Paths.cache, DOWNLOADS);
    if (!directory.exists) return;
    await sweepPartialDownloads(directory.list().filter((entry): entry is File => entry instanceof File && entry.name.endsWith('.part'))
        .map((file) => ({ modified: file.modificationTime, remove: () => file.delete() })), clear);
}

export function sweepArtifactDownloads(): Promise<void> {
    return sweepDownloads();
}

export function clearPartialDownloads(): Promise<void> {
    return sweepDownloads(true);
}

function safeName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_');
    return cleaned.length > 96 ? `${cleaned.slice(0, 79)}_${cleaned.slice(-16)}` : cleaned || 'artifact';
}

function partFile(sessionId: string, artifact: DownloadableArtifact): File {
    return new File(Paths.cache, DOWNLOADS, `${artifactDownloadKey(sessionId, artifact)}.part`);
}

/** Bytes an interrupted download left behind, e.g. before the app was closed. */
export async function restoreReadyArtifact(_sessionId: string, _artifact: DownloadableArtifact): Promise<void> {}

export function keptBytes(sessionId: string, artifact: DownloadableArtifact): number {
    const part = partFile(sessionId, artifact);
    return artifact.at !== undefined && part.exists && part.size < artifact.size ? part.size : 0;
}

function sink(artifact: DownloadableArtifact, sessionId: string): TransferSink {
    const key = artifactDownloadKey(sessionId, artifact);
    const finished = new File(Paths.cache, DOWNLOADS, key, safeName(artifact.name));
    if (artifact.at === undefined && finished.exists) finished.delete();
    if (finished.exists && finished.size === artifact.size) {
        return { offset: artifact.size, write() {}, pause() {}, discard: () => finished.delete(), finish: () => finished.uri };
    }
    const part = partFile(sessionId, artifact);
    if (part.exists && (part.size > artifact.size || artifact.at === undefined)) part.delete();
    if (!part.exists) part.create({ intermediates: true });
    const handle = part.open();
    // Append after whatever an interrupted attempt already wrote.
    handle.offset = handle.size ?? 0;
    return {
        offset: handle.offset ?? 0,
        write: (bytes) => handle.writeBytes(bytes),
        pause: () => handle.close(),
        discard: () => {
            try { handle.close(); } catch {}
            if (part.exists) part.delete();
            if (finished.exists) finished.delete();
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
