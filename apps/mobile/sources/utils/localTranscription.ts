import { initWhisper } from 'whisper.rn';
import { pcm16ChunksToArrayBuffer } from '@/utils/transcription';

const model = require('@/assets/models/ggml-base.en-q5_1.bin');

/** Transcribe short, tapped dictation entirely on-device with whisper.cpp. */
export async function transcribePcm16(chunks: readonly string[], hint?: string): Promise<string> {
    const pcm = pcm16ChunksToArrayBuffer(chunks);
    if (pcm.byteLength < 2) return '';

    const context = await initWhisper({ filePath: model });
    try {
        const { promise } = context.transcribeData(pcm, {
            language: 'en',
            maxThreads: 4,
            beamSize: 5,
            ...(hint ? { prompt: hint } : {}),
        });
        const { result } = await promise;
        return result.trim();
    } finally {
        await context.release();
    }
}
