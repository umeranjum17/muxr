import type { AgentLifecycle, LifecycleEvent, LifecycleReasonCode } from '@muxr/contract';
import { lifecycleReasonForObservation } from '../domain/lifecycle.js';

export type ReportAgentOutcomeCommand = {
    sessionId: string;
    displayName: string;
    state: AgentLifecycle;
    liveAgentStatus?: string;
    previousReason?: LifecycleReasonCode;
    taskTitle?: string;
};

export interface AgentOutcomeJournal {
    transition(
        sessionId: string,
        displayName: string,
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
        command.displayName,
        command.state,
        reason,
        command.taskTitle,
    );
    return { ok: true, data: event };
}
