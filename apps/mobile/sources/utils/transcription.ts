import { Buffer } from 'buffer';

/** Preserve the recorder's little-endian PCM16 bytes for whisper.cpp. */
export function pcm16ChunksToArrayBuffer(chunks: readonly string[]): ArrayBuffer {
    const pcm = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
    const copy = new Uint8Array(pcm.byteLength);
    copy.set(pcm);
    return copy.buffer;
}

// Dictation appends to whatever is already typed rather than replacing it, so
// speaking into a half-written prompt cannot eat the written half.
export function appendTranscript(base: string, spoken: string): string {
    const trimmed = spoken.trim();
    if (!trimmed) return base;
    return base.trim() ? `${base.trimEnd()} ${trimmed}` : trimmed;
}
