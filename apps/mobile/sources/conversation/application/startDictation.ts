export type StartDictationCommand = {
    dictating: boolean;
    realtimeLive: boolean;
};

export type StartDictationResult =
    | { ok: true }
    | { ok: false; reason: 'already' | 'busy' };

/** Claim the microphone for dictation. Realtime and dictation never share it. */
export function startDictation(command: StartDictationCommand): StartDictationResult {
    if (command.dictating) return { ok: false, reason: 'already' };
    if (command.realtimeLive) return { ok: false, reason: 'busy' };
    return { ok: true };
}
