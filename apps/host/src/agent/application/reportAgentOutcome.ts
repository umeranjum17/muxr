import type { AgentLifecycle, LifecycleEvent, LifecycleReasonCode } from '@muxr/contract';
import { lifecycleReasonForObservation } from '../domain/lifecycle.js';

export type ReportAgentOutcomeCommand = {
    sessionId: string;
    agentName: string;
    state: AgentLifecycle;
    liveAgentStatus?: string;
    previousReason?: LifecycleReasonCode;
    taskTitle?: string;
};

export interface AgentOutcomeJournal {
    transition(
        sessionId: string,
        agentName: string,
        state: AgentLifecycle,
        reason: LifecycleReasonCode,
        taskTitle?: string,
    ): LifecycleEvent | undefined;
}

export type ReportAgentOutcomeResult = { ok: true; data: LifecycleEvent | undefined };

/** Record a Lifecycle Event. Agent Route authorizes; names never do. */
export function reportAgentOutcome(
    journal: AgentOutcomeJournal,
    command: ReportAgentOutcomeCommand,
): ReportAgentOutcomeResult {
    const reason = lifecycleReasonForObservation(command.state, command.liveAgentStatus, command.previousReason);
    const event = journal.transition(
        command.sessionId,
        command.agentName,
        command.state,
        reason,
        command.taskTitle,
    );
    return { ok: true, data: event };
}
