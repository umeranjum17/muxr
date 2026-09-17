import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
    createDownloadResumable,
    DownloadResumable,
    FileSystemSessionType,
    type DownloadOptions,
    type DownloadPauseState,
    type DownloadProgressData,
} from 'expo-file-system/legacy';
import { MMKV } from 'react-native-mmkv';

export type DictationModel = {
    id: string;
    name: string;
    engine: string;
    description: string;
    fileName: string;
    sizeBytes: number;
    bundled: boolean;
    downloadUrl?: string;
};

export const BUNDLED_DICTATION_MODEL_ID = 'base.en-q5_1';
const MODEL_DIRECTORY_NAME = 'models';
const DOWNLOAD_STATE_KEY = 'dictation-model-download-v1';
const modelStorage = new MMKV();
const downloadOptions: DownloadOptions = { sessionType: FileSystemSessionType.BACKGROUND };

export const DICTATION_MODELS: readonly DictationModel[] = [
    {
        id: BUNDLED_DICTATION_MODEL_ID,
        name: 'English',
        engine: 'Whisper Base',
        description: 'bundled',
        fileName: 'ggml-base.en-q5_1.bin',
        sizeBytes: 59_721_011,
        bundled: true,
    },
    {
        id: 'base-q5_1',
        name: 'Multilingual',
        engine: 'Whisper Base',
        description: '99 languages',
        fileName: 'ggml-base-q5_1.bin',
        sizeBytes: 59_707_625,
        bundled: false,
        downloadUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin?download=true',
    },
];

export type DictationDownloadProgress = {
    bytesWritten: number;
    totalBytes: number;
};

let activeDownload: { modelId: string; task: DownloadResumable } | null = null;

function modelFor(id: string): DictationModel {
    return DICTATION_MODELS.find((model) => model.id === id) ?? DICTATION_MODELS[0];
}

function fileFor(model: DictationModel): File | null {
    if (Platform.OS === 'web' || model.bundled) return null;
    return new File(Paths.document, MODEL_DIRECTORY_NAME, model.fileName);
}

function installedFileFor(model: DictationModel): File | null {
    const file = fileFor(model);
    return file !== null && file.exists && file.size === model.sizeBytes ? file : null;
}

export function getInstalledDictationModelIds(): string[] {
    return DICTATION_MODELS.filter((model) => model.bundled || installedFileFor(model) !== null).map((model) => model.id);
}

export function getInstalledDictationModelUri(modelId: string): string | null {
    return installedFileFor(modelFor(modelId))?.uri ?? null;
}

function loadDownloadState(): DownloadPauseState | null {
    const raw = modelStorage.getString(DOWNLOAD_STATE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<DownloadPauseState>;
        if (typeof parsed.url !== 'string' || typeof parsed.fileUri !== 'string' || !parsed.options || typeof parsed.options !== 'object') return null;
        return {
            url: parsed.url,
            fileUri: parsed.fileUri,
            options: parsed.options as DownloadOptions,
            ...(typeof parsed.resumeData === 'string' ? { resumeData: parsed.resumeData } : {}),
        };
    } catch {
        modelStorage.delete(DOWNLOAD_STATE_KEY);
        return null;
    }
}

function saveDownloadState(state: DownloadPauseState): void {
    modelStorage.set(DOWNLOAD_STATE_KEY, JSON.stringify(state));
}

function clearDownloadState(): void {
    modelStorage.delete(DOWNLOAD_STATE_KEY);
}

export async function downloadDictationModel(
    modelId: string,
    onProgress?: (progress: DictationDownloadProgress) => void,
): Promise<string> {
    if (Platform.OS === 'web') throw new Error('Model downloads are available in the Android and iOS apps.');
    const model = modelFor(modelId);
    if (model.bundled || model.downloadUrl === undefined) throw new Error('This dictation model is already bundled.');
    const installed = installedFileFor(model);
    if (installed !== null) return installed.uri;
    if (activeDownload !== null) throw new Error('Another dictation model is already downloading.');

    const directory = new Directory(Paths.document, MODEL_DIRECTORY_NAME);
    directory.create({ intermediates: true, idempotent: true });
    const file = fileFor(model);
    if (file === null) throw new Error('Dictation model storage is unavailable on this device.');

    const saved = loadDownloadState();
    const resumable = saved?.url === model.downloadUrl && saved.fileUri === file.uri && file.exists
        ? new DownloadResumable(saved.url, saved.fileUri, saved.options, (data) => reportProgress(model, data, onProgress), saved.resumeData)
        : createDownloadResumable(model.downloadUrl, file.uri, downloadOptions, (data) => reportProgress(model, data, onProgress));
    activeDownload = { modelId: model.id, task: resumable };
    saveDownloadState(resumable.savable());

    try {
        const result = saved?.url === model.downloadUrl && saved.fileUri === file.uri && saved.resumeData !== undefined
            ? await resumable.resumeAsync()
            : await resumable.downloadAsync();
        if (result === undefined) throw new Error('The model download was canceled. Tap the model to try again.');

        const downloaded = new File(result.uri);
        if (!downloaded.exists || downloaded.size !== model.sizeBytes) {
            if (downloaded.exists) downloaded.delete();
            throw new Error('The downloaded model was incomplete. Check your connection and try again.');
        }
        clearDownloadState();
        onProgress?.({ bytesWritten: model.sizeBytes, totalBytes: model.sizeBytes });
        return downloaded.uri;
    } catch (error) {
        try {
            saveDownloadState(await resumable.pauseAsync());
        } catch {
            saveDownloadState(resumable.savable());
        }
        throw error;
    } finally {
        if (activeDownload?.task === resumable) activeDownload = null;
    }
}

function reportProgress(
    model: DictationModel,
    data: DownloadProgressData,
    onProgress?: (progress: DictationDownloadProgress) => void,
): void {
    onProgress?.({
        bytesWritten: data.totalBytesWritten,
        totalBytes: data.totalBytesExpectedToWrite > 0 ? data.totalBytesExpectedToWrite : model.sizeBytes,
    });
}

export function removeDownloadedDictationModel(modelId: string): void {
    const model = modelFor(modelId);
    if (model.bundled) return;
    if (activeDownload?.modelId === model.id) throw new Error('Wait for the model download to finish first.');
    const file = fileFor(model);
    if (file?.exists) file.delete();
    const saved = loadDownloadState();
    if (saved?.fileUri === file?.uri) clearDownloadState();
}