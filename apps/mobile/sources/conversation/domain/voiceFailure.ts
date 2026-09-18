/**
 * What a failed voice session means to the person holding the phone.
 *
 * The provider's own text is machine output — a JSON error object, an HTTP
 * status line — and belongs behind Details, never in someone's face. A refused
 * credential is the one failure with a single obvious remedy, so it gets named
 * and the rest stay honest about knowing only that voice did not start.
 */
export interface VoiceFailure {
    /** One plain sentence: what happened. Never an error code. */
    headline: string;
    /** What resolves it, when there is a known remedy. */
    remedy?: string;
    /** The provider's own words, whole, for the Details disclosure. */
    detail: string;
}

/**
 * Codex names itself on its credential failures: a "codex login" mention is
 * the explicit marker, and a "Codex ..." reason refused with 401/403 at
 * signaling is the same credential without the marker. Either way the sign-in
 * on the machine stopped working and cannot be repaired from the phone.
 *
 * Only Codex earns a named remedy. A key-based provider's 401/403 is not
 * reliably a bad key -- an out-of-credits account refuses with 403 too (see
 * the "out-of-credits 403" note in providers/xai.mjs and gemini.mjs) -- so
 * telling that person to replace a working key would be confidently wrong.
 * Those fall through to the plain headline with the provider's own words
 * behind Details, which is honest about what we do and do not know.
 */
const CODEX_SIGN_IN = /\bcodex login\b/i;
const REFUSED_CREDENTIAL = /\((?:401|403)\)|\bHTTP (?:401|403)\b/i;

export function voiceFailure(reason: string, machineName: string): VoiceFailure {
    const detail = reason.trim();
    if (CODEX_SIGN_IN.test(detail) || (detail.startsWith('Codex ') && REFUSED_CREDENTIAL.test(detail))) {
        return {
            headline: 'Codex needs a new sign-in.',
            remedy: `Sign in to Codex on ${machineName}, then start voice again.`,
            detail,
        };
    }
    return { headline: 'Voice couldn’t start.', detail };
}
