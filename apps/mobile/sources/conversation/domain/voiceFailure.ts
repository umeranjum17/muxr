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
 * the explicit marker, and a "Codex ..." reason refused with 401 at signaling
 * is the same credential without the marker. Either way the sign-in on the
 * machine stopped working and cannot be repaired from the phone.
 *
 * A key-based provider says the same thing in its own spelling: every bundled
 * adapter formats a refusal as "... (HTTP <status>)", and a 401 there means the
 * key itself was not accepted. Only 401. A 403 is the authenticated-but-refused
 * case -- out of credits, or a plan that does not include realtime -- and
 * telling that person to replace a working key would be confidently wrong, so
 * 403 falls through to the plain headline with the provider's own words behind
 * Details, which is honest about what we do and do not know.
 */
const CODEX_SIGN_IN = /\bcodex login\b/i;
const REFUSED_CREDENTIAL = /\(401\)/;
const REFUSED_KEY = /\(HTTP 401\)/;

/**
 * `started` is whether this call ever reached the provider. Without it a call
 * that ran for two minutes and then dropped would be labelled as one that
 * never began.
 */
export function voiceFailure(reason: string, machineName: string, started: boolean): VoiceFailure {
    const detail = reason.trim();
    if (CODEX_SIGN_IN.test(detail) || (detail.startsWith('Codex ') && REFUSED_CREDENTIAL.test(detail))) {
        return {
            headline: 'Codex needs a new sign-in.',
            remedy: `Sign in to Codex on ${machineName}, then start voice again.`,
            detail,
        };
    }
    if (REFUSED_KEY.test(detail)) {
        return {
            headline: 'The voice provider rejected its key.',
            remedy: `Set a new provider key in muxr Settings on ${machineName}, then start voice again.`,
            detail,
        };
    }
    return { headline: started ? 'Voice disconnected.' : 'Voice couldn’t start.', detail };
}
