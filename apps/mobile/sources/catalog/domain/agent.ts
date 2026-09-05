import { isSessionIdle, type SessionInfo, type SessionStatus } from '@muxr/contract';
import deepEqual from 'fast-deep-equal';
import type { Session } from '../infrastructure/storageTypes';
import {
    lifecycleIsBusy,
    lifecycleNeedsApproval,
    lifecycleSince,
} from '@/watch';

/**
 * How long a quiet Agent keeps counting as listed. Pi sessions never report
 * going offline, so a hardcoded `active: true` piled every Agent muxr had
 * ever seen into the live group and none of them ever left.
 */
export const AGENT_STILL_LISTED_MS = 30 * 60 * 1000;


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
    return session.thinking === !isSessionIdle(status)
        && session.metadata?.agentStatus === status.agentStatus
        && session.metadata?.promptable === status.promptable;
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

/** Drop pre-cutover display copies while preserving generic non-Herdr session metadata. */
function withoutCopiedHerdrIdentity(metadata: Session['metadata']): Session['metadata'] {
    if (metadata?.client?.id !== 'herdr') return metadata;
    const {
        agentName: _agentName,
        taskTitle: _taskTitle,
        summary: _summary,
        ...current
    } = metadata;
    return current;
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
    const known = withoutCopiedHerdrIdentity(previous?.metadata ?? null);
    const incoming = withoutCopiedHerdrIdentity(session.metadata);
    const metadata = incoming === null
        ? incoming
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
            ...incoming,
        };
    const catalogHasLifecycle = incoming?.agentStatus !== undefined;
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
        // The host omits `created`; the first value this device saw is the creation time.
        ...(previous === undefined ? {} : { createdAt: previous.createdAt }),
        metadata,
        presence: session.presence ?? onlineState(session),
    };
}

/** Live info churn carries a fresh host DTO but no status; keep status-derived fields. */
export function applyHostInfoToAgent(existing: Session, fresh: Session): Session {
    const known = withoutCopiedHerdrIdentity(existing.metadata);
    const incoming = withoutCopiedHerdrIdentity(fresh.metadata);
    // The host omits `created`, so every mapping stamps a fresh `createdAt`.
    // Keeping the known value is what lets the equality check below recognise
    // an unchanged session; without it every info frame was a store write, and
    // the herd re-rendered every card several times a second.
    const merged: Session = {
        ...existing,
        ...fresh,
        createdAt: existing.createdAt,
        thinking: existing.thinking,
        thinkingAt: existing.thinkingAt,
        agentState: existing.agentState,
        agentStateVersion: existing.agentStateVersion,
        metadata: known === null
            ? incoming
            : {
                  ...known,
                  ...incoming,
              },
    };
    const withoutOutputTimestamps: Session = {
        ...merged,
        updatedAt: existing.updatedAt,
        activeAt: existing.activeAt,
        presence: existing.presence,
    };
    return deepEqual(withoutOutputTimestamps, existing) ? existing : merged;
}
