declare global {
    var __VOICE_DIAGNOSTICS__: boolean | undefined;
}

type VoiceDiagnosticMarker =
    | 'dictate.tap'
    | 'permission.begin'
    | 'permission.end'
    | 'dictation.claim.begin'
    | 'dictation.claim.end'
    | 'manual-live.tap'
    | 'startVoice.enter'
    | 'startVoice.guard:dictating'
    | 'startVoice.guard:duplicate'
    | 'startVoice.guard:pinned';

/** Fixed, non-sensitive stage markers; disabled in release builds. */
export function voiceDiagnostic(marker: VoiceDiagnosticMarker): void {
    if (!((typeof __DEV__ !== 'undefined' && __DEV__) || globalThis.__VOICE_DIAGNOSTICS__ === true)) return;
    console.debug(`[voice] ${marker}`);
}

export {};
