import { lifecycleEventAgentName, type AgentLifecycle, type LifecycleEvent } from '@muxr/contract';

export interface RecentActivityRow {
    eventId: string;
    sessionId: string;
    taskTitle: string;
    agentName?: string;
    agentKind?: string;
    status: Extract<AgentLifecycle, 'blocked' | 'done' | 'failed'>;
    reasonCode: string;
    at: number;
}

const VISIBLE_STATES = new Set<AgentLifecycle>(['blocked', 'done', 'failed']);
const MAX_AGE_MS = 24 * 60 * 60_000;

function sameLabel(left?: string, right?: string): boolean {
    return left !== undefined && right !== undefined
        && left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

/** Prefer a work title. Animal names are identity, never the task line. */
function resolveActivityTaskTitle(
    event: { taskTitle?: string; agentName: string },
    liveTitle?: string,
): string {
    const stored = event.taskTitle?.trim();
    const name = event.agentName.trim();
    const live = liveTitle?.trim();
    if (stored !== undefined && stored !== '' && !sameLabel(stored, name)) return stored;
    if (live !== undefined && live !== '' && !sameLabel(live, name)) return live;
    return stored || name;
}
export { resolveActivityTaskTitle };

/**
 * When the host recorded this agent entering the state it is in now, from its
 * newest transition (events arrive newest first). The phone's own first
 * sighting is no such time: after a relaunch it reads "now" for an agent that
 * finished an hour ago. Undefined when the newest transition says otherwise.
 */
export function lifecycleStateSince(
    events: readonly LifecycleEvent[],
    sessionId: string,
    state: AgentLifecycle,
): number | undefined {
    const latest = events.find((event) => event.sessionId === sessionId);
    // `idle` is how older herdr providers report a finished turn.
    if (latest === undefined || (latest.state !== state && !(state === 'idle' && latest.state === 'done'))) return undefined;
    const at = Date.parse(latest.at);
    return Number.isFinite(at) ? at : undefined;
}

/** Unseen meaningful transitions only; latest event wins when one agent changed repeatedly. */
export function unseenActivityRows(
    events: readonly LifecycleEvent[],
    seenEventIds: ReadonlySet<string>,
    now = Date.now(),
    limit = 8,
    liveTitles?: ReadonlyMap<string, string>,
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
            taskTitle: resolveActivityTaskTitle(event, liveTitles?.get(event.sessionId)),
            agentName: lifecycleEventAgentName(event),
            ...(event.agentKind === undefined ? {} : { agentKind: event.agentKind }),
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

/**
 * Sessions whose latest meaningful transition is a done outcome you have not
 * opened, derived from the same rows as the READY · UNSEEN tier so a highlight
 * and the tier can never disagree about seen-ness.
 */
export function unseenDoneSessionIds(
    events: readonly LifecycleEvent[],
    seenEventIds: ReadonlySet<string>,
    now = Date.now(),
): ReadonlySet<string> {
    // ponytail: same 8-row ceiling as the tier; an agent beyond the 8 newest
    // unseen outcomes stays unhighlighted. Raise both together if that bites.
    return new Set(unseenActivityRows(events, seenEventIds, now, 8)
        .filter((row) => row.status === 'done')
        .map((row) => row.sessionId));
}
