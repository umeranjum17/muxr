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
 * The two refused credentials are fixed in two different places, so each one
 * names the device its own fix happens on and the wording is not shared.
 *
 * Codex names itself on its credential failures: a "codex login" mention is the
 * explicit marker, and a "Codex ..." reason refused with 401 at signaling is the
 * same credential without the marker. That sign-in lives on the machine and
 * cannot be repaired from the phone, so its remedy names the machine.
 *
 * A key-based provider says the same thing in its own spelling: every bundled
 * adapter formats a refusal as "... (HTTP <status>)", and a 401 there means the
 * key itself was not accepted. That key is typed on the phone and sent to the
 * machine, so its remedy names the screen, never a computer to walk to.
 *
 * Only 401 either way. A 403 is the authenticated-but-refused case -- out of
 * credits, or a plan that does not include realtime -- and telling that person
 * to replace a working key would be confidently wrong, so 403 falls through to
 * the plain headline with the provider's own words behind Details, which is
 * honest about what we do and do not know.
 */
const CODEX_SIGN_IN = /\bcodex login\b/i;
const REFUSED_CREDENTIAL_ON_THE_MACHINE = /\(401\)/;
const REFUSED_KEY_FROM_THE_PHONE = /\(HTTP 401\)/;

export function voiceFailure(reason: string, machineName: string): VoiceFailure {
    const detail = reason.trim();
    if (CODEX_SIGN_IN.test(detail) || (detail.startsWith('Codex ') && REFUSED_CREDENTIAL_ON_THE_MACHINE.test(detail))) {
        return {
            headline: 'Codex needs a new sign-in.',
            remedy: `Sign in to Codex on ${machineName}, then start voice again.`,
            detail,
        };
    }
    if (REFUSED_KEY_FROM_THE_PHONE.test(detail)) {
        return {
            headline: 'The voice provider rejected its key.',
            remedy: 'Set a new key in Settings › Voice & dictation, then start voice again.',
            detail,
        };
    }
    return { headline: 'Voice stopped.', detail };
}
