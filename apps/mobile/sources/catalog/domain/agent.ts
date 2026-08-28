import { isSessionIdle, type SessionInfo, type SessionStatus } from '@muxr/contract';
import type { Session } from '@/sync/storageTypes';
import {
    lifecycleIsBusy,
    lifecycleNeedsApproval,
    lifecycleSince,
} from '@/sync/lifecycle';

/**
 * How long a quiet Agent keeps counting as listed. Pi sessions never report
 * going offline, so a hardcoded `active: true` piled every Agent muxr had
 * ever seen into the live group and none of them ever left.
 */
export const AGENT_STILL_LISTED_MS = 30 * 60 * 1000;

const FALLBACK_TASK_TITLE = 'Current task';

/**
 * Undefined means "no Human Name yet", not "use the folder name": falling back
 * to the cwd basename gave every Agent in a repo the same name, and each
 * catalog refresh overwrote a real Human Name with it.
 */
export function humanNameFromHost(info: Pick<SessionInfo, 'displayName' | 'name'>): string | undefined {
    if (info.displayName !== undefined && info.displayName.trim().length > 0) return info.displayName.trim();
    if (info.name !== undefined && info.name.trim().length > 0) return info.name.trim();
    return undefined;
}

export function taskTitleFromHost(raw: string | undefined): string {
    const trimmed = raw?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : FALLBACK_TASK_TITLE;
}

export function providerKindFromHost(raw: string | undefined): { kind: string; name: string } {
    const kind = raw === undefined || raw === '' ? 'agent' : raw;
    return { kind, name: kind.charAt(0).toUpperCase() + kind.slice(1) };
}

export function agentIsBusy(status: SessionStatus | undefined): boolean {
    return lifecycleIsBusy(status);
}

export function agentNeedsApproval(status: SessionStatus | undefined): boolean {
    return lifecycleNeedsApproval(status?.agentStatus);
}

export function agentStillListed(busy: boolean, updatedAt: number, now: number): boolean {
    return busy || now - updatedAt < AGENT_STILL_LISTED_MS;
}

export function agentStatusUnchanged(session: Session, status: SessionStatus): boolean {
    return session.thinking === !isSessionIdle(status) && session.metadata?.agentStatus === status.agentStatus;
}

/**
 * A blocked Agent has an approval UI on screen. The row state for that is
 * already `permission_required`, which is driven by `agentState.requests` -- so
 * publish one synthetic request rather than inventing a second vocabulary. The
 * answer is keys in the terminal, not an allow/deny RPC.
 */
export function approvalAgentState(spokenName: string): NonNullable<Session['agentState']> {
    return {
        usageLimits: { capturedAt: Date.now(), windows: [] },
        requests: { herdr: { tool: `${spokenName} is waiting for you`, arguments: {}, createdAt: Date.now() } },
    };
}

export function humanNameForNotice(session: Session | undefined): string {
    const name = session?.metadata?.displayName?.trim();
    return name && name.length > 0 ? name : 'Agent';
}

export function agentHasOpenApproval(session: Pick<Session, 'agentState'>): boolean {
    const requests = session.agentState?.requests;
    return requests != null && Object.keys(requests).length > 0;
}

export type AgentRowAttention = 'disconnected' | 'permission_required' | 'thinking' | 'waiting';

export function agentRowAttention(session: Pick<Session, 'presence' | 'agentState' | 'thinking'>): AgentRowAttention {
    if (session.presence !== 'online') return 'disconnected';
    if (agentHasOpenApproval(session)) return 'permission_required';
    if (session.thinking) return 'thinking';
    return 'waiting';
}

export function lifecycleSinceForAgent(
    metadata: NonNullable<Session['metadata']>,
    nextStatus: SessionStatus['agentStatus'],
    now: number,
): number {
    return lifecycleSince(metadata.agentStatus, metadata.lifecycleStateSince, nextStatus, now);
}

/**
 * Catalog refresh replaces metadata wholesale and carries neither a Task Title
 * nor live lifecycle. Carry those over or a refresh briefly turns working or
 * blocked Agents into done Agents, fires false completion notices, and re-arms
 * the recent-agent buffer.
 */
export function mergeCatalogAgent(
    storePrevious: Session | undefined,
    mergedPrevious: Session | undefined,
    session: Omit<Session, 'presence'> & { presence?: 'online' | number },
    replace: boolean,
    onlineState: (session: { active: boolean; activeAt: number }) => 'online' | number,
): Session {
    const previous = replace ? storePrevious : mergedPrevious;
    const known = previous?.metadata;
    const metadata = session.metadata === null
        ? session.metadata
        : {
            ...(known?.summary === undefined ? {} : { summary: known.summary }),
            ...(known?.currentModelCode === undefined ? {} : {
                currentModelCode: known.currentModelCode,
                currentModelProviderId: known.currentModelProviderId,
            }),
            ...(known?.currentThoughtLevelCode === undefined
                ? {}
                : { currentThoughtLevelCode: known.currentThoughtLevelCode }),
            ...(known?.agentStatus === undefined
                ? {}
                : {
                      agentStatus: known.agentStatus,
                      lifecycleStateSince: known.lifecycleStateSince,
                  }),
            ...session.metadata,
        };
    const catalogHasLifecycle = session.metadata?.agentStatus !== undefined;
    const liveStatus = previous !== undefined && !catalogHasLifecycle
        ? {
              thinking: previous.thinking,
              thinkingAt: previous.thinkingAt,
              agentState: previous.agentState,
              agentStateVersion: previous.agentStateVersion,
          }
        : {};
    return {
        ...previous,
        ...session,
        ...liveStatus,
        metadata,
        presence: session.presence ?? onlineState(session),
    };
}

/** Live info churn carries a fresh host DTO but no status; keep status-derived fields. */
export function applyHostInfoToAgent(existing: Session, fresh: Session): Session {
    return {
        ...existing,
        ...fresh,
        thinking: existing.thinking,
        thinkingAt: existing.thinkingAt,
        agentState: existing.agentState,
        agentStateVersion: existing.agentStateVersion,
        latestUsage: existing.latestUsage,
        metadata: existing.metadata === null
            ? fresh.metadata
            : { ...existing.metadata, ...fresh.metadata },
    };
}
