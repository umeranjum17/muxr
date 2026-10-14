import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
    createDownloadResumable,
    FileSystemSessionType,
} from 'expo-file-system/legacy';
import { installModel, WHISPER_VAD_MODEL, type DictateModel, type DictateModelStore } from '@byokit/dictation';
import { artifactChunkHash } from '@/utils/artifactChunkHash';
import { readFileBytes } from '@/utils/readFileBytes';

const MODEL_DIRECTORY_NAME = 'models';
const FILE_NAME = `${WHISPER_VAD_MODEL.id}.bin`;

/** Resolved once per JS runtime so a missing gate is not retried on every take. */
let cachedUri: string | null | undefined;

function vadFile(): File | null {
    if (Platform.OS === 'web') return null;
    return new File(Paths.document, MODEL_DIRECTORY_NAME, FILE_NAME);
}

async function hashUri(uri: string): Promise<string> {
    return artifactChunkHash(await readFileBytes(uri));
}

function modelStore(file: File): DictateModelStore {
    return {
        async size(m) {
            return file.exists && file.size === m.bytes ? file.size : undefined;
        },
        async download(m, o) {
            const directory = new Directory(Paths.document, MODEL_DIRECTORY_NAME);
            directory.create({ intermediates: true, idempotent: true });
            const resumable = createDownloadResumable(
                m.url,
                file.uri,
                { sessionType: FileSystemSessionType.BACKGROUND },
                (data) => {
                    const total = data.totalBytesExpectedToWrite > 0 ? data.totalBytesExpectedToWrite : m.bytes;
                    o.onProgress?.(total > 0 ? data.totalBytesWritten / total : 0);
                },
            );
            const result = await resumable.downloadAsync();
            if (result === undefined) throw new Error('The speech gate model download was canceled.');
        },
        async sha256() {
            return hashUri(file.uri);
        },
        async remove() {
            if (file.exists) file.delete();
        },
    };
}

/**
 * Local Silero VAD graph for whisper.rn. Download-on-demand with size + SHA-256
 * via the kit's `installModel` + `WHISPER_VAD_MODEL`. Returns null when missing
 * or unloadable so dictation can continue without a speech gate.
 */
export async function getDictationVadModelUri(): Promise<string | null> {
    if (cachedUri !== undefined) return cachedUri;
    const file = vadFile();
    if (file === null) {
        cachedUri = null;
        return null;
    }
    try {
        if (file.exists && file.size === WHISPER_VAD_MODEL.bytes) {
            const digest = await hashUri(file.uri);
            if (digest.toLowerCase() === WHISPER_VAD_MODEL.sha256.toLowerCase()) {
                cachedUri = file.uri;
                return cachedUri;
            }
            file.delete();
        }
        await installModel(WHISPER_VAD_MODEL as DictateModel, modelStore(file));
        cachedUri = file.exists && file.size === WHISPER_VAD_MODEL.bytes ? file.uri : null;
        return cachedUri;
    } catch (error) {
        console.warn('Dictation speech gate unavailable; continuing without it:', error);
        try {
            if (file.exists) file.delete();
        } catch {
            // ignore cleanup failure
        }
        cachedUri = null;
        return null;
    }
}
