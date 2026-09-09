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

export function realtimeCallLabel(
    state: 'disconnected' | 'connecting' | 'thinking' | 'speaking' | 'connected',
    watching: boolean,
    muted: boolean,
    speaking: boolean,
): string {
    if (state === 'disconnected' && watching) return 'Asleep — watching agent';
    if (state === 'disconnected') return 'Asleep — tap the mic to wake';
    if (state === 'connecting') return 'Connecting…';
    if (state === 'thinking') return 'Thinking…';
    if (speaking) return 'Speaking';
    if (muted) return 'Microphone muted';
    return 'Listening';
}
