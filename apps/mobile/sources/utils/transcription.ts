// Dictation appends to whatever is already typed rather than replacing it, so
// speaking into a half-written prompt cannot eat the written half.
export function appendTranscript(base: string, spoken: string): string {
    const trimmed = spoken.trim();
    if (!trimmed) return base;
    return base.trim() ? `${base.trimEnd()} ${trimmed}` : trimmed;
}
