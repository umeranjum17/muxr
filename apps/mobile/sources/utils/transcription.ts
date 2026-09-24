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

const wordKey = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Live words for speech that is still being re-read: only the words two
 * readings in a row agree on are shown, and shown words are never taken back,
 * so the text grows without flicker while its unsure tail waits a beat.
 */
export function settleWords(shown: string, previous: string, next: string): string {
    const before = previous.split(/\s+/).filter(Boolean);
    const after = next.split(/\s+/).filter(Boolean);
    let agreed = 0;
    while (agreed < before.length && agreed < after.length && wordKey(before[agreed]) === wordKey(after[agreed])) agreed += 1;
    const kept = shown.split(/\s+/).filter(Boolean);
    if (agreed <= kept.length || kept.some((word, index) => wordKey(word) !== wordKey(after[index]))) return shown;
    return after.slice(0, agreed).join(' ');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\[\]\\]/g, '\\$&');
}

function isWordCharacter(value: string | undefined): boolean {
    return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

/** Apply user-owned corrections without changing larger words that merely contain one. */
export function applyWordReplacements(
    text: string,
    replacements: readonly { from: string; to: string }[],
): string {
    return replacements.reduce((result, replacement) => {
        const from = replacement.from.trim();
        const to = replacement.to.trim();
        if (!from || !to) return result;
        const pattern = new RegExp(escapeRegExp(from), 'gi');
        return result.replace(pattern, (match: string, offset: number, source: string) => {
            if (isWordCharacter(source[offset - 1]) || isWordCharacter(source[offset + match.length])) return match;
            return to;
        });
    }, text);
}
