import { initWhisper } from 'whisper.rn';
import { loadLocalSettings } from '@/catalog/application/persistence';
import { applyWordReplacements, pcm16ChunksToArrayBuffer } from '@/utils/transcription';
import { BUNDLED_DICTATION_MODEL_ID, getInstalledDictationModelUri } from '@/utils/dictationModels';

const bundledModel = require('@/assets/models/ggml-base.en-q5_1.bin');

/** Transcribe short, tapped dictation entirely on-device with whisper.cpp. */
export async function transcribePcm16(chunks: readonly string[], hint?: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return '';
    const pcm = pcm16ChunksToArrayBuffer(chunks);
    if (pcm.byteLength < 2) return '';

    const settings = loadLocalSettings();
    const selectedModel = settings.dictationModel || BUNDLED_DICTATION_MODEL_ID;
    const modelUri = getInstalledDictationModelUri(selectedModel);
    const context = await initWhisper({ filePath: modelUri ?? bundledModel });
    let cancel: (() => void) | undefined;
    try {
        if (signal?.aborted) return '';
        const { promise, stop } = context.transcribeData(pcm, {
            language: settings.dictationLanguage ?? 'auto',
            maxThreads: 4,
            beamSize: 5,
            ...(hint ? { prompt: hint } : {}),
        });
        cancel = () => { void stop().catch(() => undefined); };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        const { result } = await promise;
        if (signal?.aborted) return '';
        return applyWordReplacements(result.trim(), settings.dictationWordReplacements).trim();
    } finally {
        if (cancel !== undefined) signal?.removeEventListener('abort', cancel);
        await context.release();
    }
}
