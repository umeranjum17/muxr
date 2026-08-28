import { lifecycleEventAgentName, type AgentLifecycle, type LifecycleEvent } from '@muxr/contract';

export interface RecentActivityRow {
    eventId: string;
    sessionId: string;
    taskTitle: string;
    agentName?: string;
    status: Extract<AgentLifecycle, 'blocked' | 'done' | 'failed'>;
    reasonCode: string;
    at: number;
}

const VISIBLE_STATES = new Set<AgentLifecycle>(['blocked', 'done', 'failed']);
const MAX_AGE_MS = 24 * 60 * 60_000;

/** Unseen meaningful transitions only; latest event wins when one agent changed repeatedly. */
export function unseenActivityRows(
    events: readonly LifecycleEvent[],
    seenEventIds: ReadonlySet<string>,
    now = Date.now(),
    limit = 8,
): RecentActivityRow[] {
    const latestRoutes = new Set<string>();
    const rows: RecentActivityRow[] = [];
    for (const event of events) {
        if (!VISIBLE_STATES.has(event.state) || latestRoutes.has(event.sessionId)) continue;
        latestRoutes.add(event.sessionId);
        if (seenEventIds.has(event.eventId)) continue;
        const at = Date.parse(event.at);
        if (!Number.isFinite(at) || now - at > MAX_AGE_MS) continue;
        rows.push({
            eventId: event.eventId,
            sessionId: event.sessionId,
            taskTitle: event.taskTitle?.trim() || 'Untitled task',
            agentName: lifecycleEventAgentName(event),
            status: event.state as RecentActivityRow['status'],
            reasonCode: event.reasonCode,
            at,
        });
        if (rows.length === limit) break;
    }
    return rows;
}

export function recentActivityStatus(row: RecentActivityRow): string {
    if (row.status === 'failed' && ['start-launch-failed', 'start-timeout', 'squad-rolled-back', 'agent-unavailable'].includes(row.reasonCode)) {
        return 'Could not start';
    }
    if (row.status === 'blocked') return 'Needs you';
    if (row.status === 'done') return 'Done';
    return 'Failed';
}
