import { Asset } from 'expo-asset';

// Pinned Silero VAD graph from @byokit/dictation's WHISPER_VAD_MODEL (size and SHA-256 checked when fetched).
const bundledVadModel: number = require('@/assets/models/ggml-silero-v6.2.0.bin');

/**
 * Local Silero VAD graph for whisper.rn. Null when it cannot be materialized, so
 * dictation continues without a speech gate; nothing is cached, so the next take retries.
 */
export async function getDictationVadModelUri(): Promise<string | null> {
    try {
        const asset = Asset.fromModule(bundledVadModel);
        await asset.downloadAsync();
        return asset.localUri ?? null;
    } catch (error) {
        console.warn('Dictation speech gate unavailable; continuing without it:', error);
        return null;
    }
}
