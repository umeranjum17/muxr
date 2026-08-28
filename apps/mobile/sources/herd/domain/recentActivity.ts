import type { AgentLifecycle, LifecycleEvent } from '@muxr/contract';

export interface RecentActivityRow {
    eventId: string;
    taskTitle: string;
    humanName?: string;
    status: Extract<AgentLifecycle, 'blocked' | 'done' | 'failed'>;
    reasonCode: string;
    at: number;
}

const VISIBLE_STATES = new Set<AgentLifecycle>(['blocked', 'done', 'failed']);

/** Latest human-meaningful transition per agent; raw lifecycle churn stays hidden. */
export function recentActivityRows(events: readonly LifecycleEvent[], limit = 8): RecentActivityRow[] {
    const seen = new Set<string>();
    const rows: RecentActivityRow[] = [];
    for (const event of events) {
        if (!VISIBLE_STATES.has(event.state) || seen.has(event.sessionId)) continue;
        const at = Date.parse(event.at);
        if (!Number.isFinite(at)) continue;
        seen.add(event.sessionId);
        rows.push({
            eventId: event.eventId,
            taskTitle: event.taskTitle?.trim() || 'Untitled task',
            humanName: event.displayName.trim() || undefined,
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
