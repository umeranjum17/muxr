import type { AgentLifecycle, LifecycleReasonCode } from '@muxr/contract';

export function lifecycleReasonForObservation(
    state: AgentLifecycle,
    liveAgentStatus: string | undefined,
    previous: LifecycleReasonCode | undefined,
): LifecycleReasonCode {
    if (state === 'working') return 'agent-working';
    if (state === 'blocked') return 'agent-blocked';
    if (state === 'done') return 'agent-done';
    if (state !== 'failed') return 'state-reconciled';
    if (liveAgentStatus === 'failed') return 'agent-runtime-failed';
    if (
        previous === 'start-launch-failed'
        || previous === 'start-timeout'
        || previous === 'squad-rolled-back'
        || previous === 'agent-unavailable'
        || previous === 'agent-runtime-failed'
    ) {
        return previous;
    }
    return 'state-reconciled';
}

export function lifecycleRank(status: AgentLifecycle): number {
    if (status === 'blocked') return 6;
    if (status === 'failed') return 5;
    if (status === 'working') return 4;
    if (status === 'starting') return 3;
    if (status === 'done') return 2;
    if (status === 'idle') return 1;
    return 0;
}

export function rollupLifecycle(statuses: readonly AgentLifecycle[]): AgentLifecycle {
    let best: AgentLifecycle = 'unknown';
    for (const status of statuses) {
        if (lifecycleRank(status) > lifecycleRank(best)) best = status;
    }
    return best;
}
