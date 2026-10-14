import { Asset } from 'expo-asset';
import { initWhisperVad } from 'whisper.rn';

// Pinned Silero VAD graph from @byokit/dictation's WHISPER_VAD_MODEL (size and SHA-256 checked when fetched).
const bundledVadModel: number = require('@/assets/models/ggml-silero-v6.2.0.bin');

let openUri: string | undefined;

/**
 * Local Silero VAD graph for whisper.rn, proven to open. Null when it cannot be
 * materialized or opened, so dictation continues without a speech gate; only a
 * success is cached, so the next take retries.
 */
export async function getDictationVadModelUri(): Promise<string | null> {
    if (openUri !== undefined) return openUri;
    try {
        const asset = Asset.fromModule(bundledVadModel);
        await asset.downloadAsync();
        if (!asset.localUri) return null;
        const vad = await initWhisperVad({ filePath: asset.localUri });
        await vad.release();
        openUri = asset.localUri;
        return openUri;
    } catch (error) {
        console.warn('Dictation speech gate unavailable; continuing without it:', error);
        return null;
    }
}
