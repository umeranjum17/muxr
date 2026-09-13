export type MicOwner = 'realtime' | 'dictation' | 'vad';

export type RealtimeStartDecision = 'ok' | 'dictating' | 'duplicate' | 'pinned';

export type RealtimeMachineSwitchGuard =
    | { allowed: true }
    | { allowed: false; reason: 'voice-active'; action: 'end-voice-and-switch' };

/** Dictation, Realtime Playback, and VAD standby never own the microphone together. */
export function exclusiveMicOwners(parts: {
    dictating: boolean;
    realtimeLive: boolean;
    vadOwns: boolean;
}): MicOwner[] {
    const owners: MicOwner[] = [];
    if (parts.dictating) owners.push('dictation');
    if (parts.realtimeLive) owners.push('realtime');
    if (parts.vadOwns) owners.push('vad');
    return owners;
}

export function decideRealtimeStart(parts: {
    dictating: boolean;
    realtimeLive: boolean;
    bound: { machineId: string; sessionId: string } | null;
    target: { machineId: string; sessionId: string };
}): RealtimeStartDecision {
    if (parts.dictating) return 'dictating';
    if (!parts.realtimeLive) return 'ok';
    const sameTarget = parts.bound?.machineId === parts.target.machineId
        && parts.bound.sessionId === parts.target.sessionId;
    return sameTarget ? 'duplicate' : 'pinned';
}

export function machineSwitchAllowed(
    boundMachineId: string | null,
    nextMachineId: string,
): RealtimeMachineSwitchGuard {
    return boundMachineId !== null && boundMachineId !== nextMachineId
        ? { allowed: false, reason: 'voice-active', action: 'end-voice-and-switch' }
        : { allowed: true };
}

/**
 * Why voice is not running, read from the stop detail. Each reason has a
 * different next action, so none of them may be presented as "asleep".
 */
export type VoiceStopReason = 'denied' | 'suspended' | 'paused' | 'failed';

export function voiceStopReason(detail: string | undefined): VoiceStopReason | undefined {
    if (detail === undefined || detail === '') return undefined;
    if (/denied|not ?allowed|permission/i.test(detail)) return 'denied';
    if (/suspended/i.test(detail)) return 'suspended';
    if (/background/i.test(detail)) return 'paused';
    return 'failed';
}

export function realtimeCallLabel(
    state: 'disconnected' | 'connecting' | 'thinking' | 'speaking' | 'connected',
    watching: boolean,
    muted: boolean,
    speaking: boolean,
    reason?: VoiceStopReason,
): string {
    if (state === 'disconnected' && reason === 'denied') return 'Microphone blocked — allow it for this site, then tap the mic';
    if (state === 'disconnected' && reason === 'suspended') return 'Audio is paused by the browser — tap the mic to resume';
    if (state === 'disconnected' && reason === 'paused') return 'Paused in the background — tap the mic to continue';
    if (state === 'disconnected' && reason === 'failed') return 'Voice stopped — tap the mic to retry';
    if (state === 'disconnected' && watching) return 'Asleep — watching agent';
    if (state === 'disconnected') return 'Asleep — tap the mic to wake';
    if (state === 'connecting') return 'Connecting…';
    if (state === 'thinking') return 'Thinking…';
    if (speaking) return 'Speaking';
    if (muted) return 'Microphone muted';
    return 'Listening';
}
