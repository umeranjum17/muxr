import type { SessionStatus } from '@muxr/contract';
import { isSessionIdle } from '@muxr/contract';

export type LifecycleState = NonNullable<SessionStatus['agentStatus']>;

/** A blocked Agent is showing an approval UI and cannot move without the person. */
export function lifecycleNeedsApproval(state: string | undefined): boolean {
    return state === 'blocked';
}

/** Busy covers descendants: a parent with live subagents is not idle. */
export function lifecycleIsBusy(status: SessionStatus | undefined): boolean {
    return status !== undefined && !isSessionIdle(status);
}

export function lifecycleIsWorking(state: string | undefined): boolean {
    return state === 'working';
}

/** Desk focus only if that Agent is working or blocked. */
export function lifecycleIsDeskFocus(state: string | undefined): boolean {
    return lifecycleIsWorking(state) || lifecycleNeedsApproval(state);
}

/** Lifecycle Events that must interrupt: blocked, failed, or done. */
export function lifecycleNeedsNotification(state: string): boolean {
    return state === 'blocked' || state === 'failed' || state === 'done';
}

/** Idle and done Voice Reports are routine and share a tighter admission cap. */
export function lifecycleIsRoutineVoice(status: string): boolean {
    return status === 'idle' || status === 'done';
}

export function lifecycleWatchOutcome(status: string): string {
    if (status === 'done' || status === 'idle') return 'finished';
    if (status === 'blocked') return 'needs attention';
    return status;
}

/** The time the Agent entered this Lifecycle Event state, not the last tick. */
export function lifecycleSince(
    previousState: string | undefined,
    previousSince: number | undefined,
    nextState: string | undefined,
    now: number,
): number {
    if (nextState === previousState && previousSince !== undefined) return previousSince;
    return now;
}
