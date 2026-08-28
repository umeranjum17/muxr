import { decideRealtimeStart, type RealtimeStartDecision } from '../domain/micOwnership';

export type StartRealtimeConversationCommand = {
    machineId: string;
    agentRoute: string;
    dictating: boolean;
    realtimeLive: boolean;
    bound: { machineId: string; agentRoute: string } | null;
};

export type StartRealtimeConversationResult =
    | { ok: true }
    | { ok: false; reason: Exclude<RealtimeStartDecision, 'ok'> };

/** Open the speech-to-speech call on an Agent Route when Mic Ownership allows it. */
export function startRealtimeConversation(
    command: StartRealtimeConversationCommand,
): StartRealtimeConversationResult {
    const decision = decideRealtimeStart({
        dictating: command.dictating,
        realtimeLive: command.realtimeLive,
        bound: command.bound === null
            ? null
            : { machineId: command.bound.machineId, sessionId: command.bound.agentRoute },
        target: { machineId: command.machineId, sessionId: command.agentRoute },
    });
    if (decision !== 'ok') return { ok: false, reason: decision };
    return { ok: true };
}
