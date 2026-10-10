import { lifecycleEventAgentName, type AgentLifecycle, type LifecycleEvent } from '@trymuxr/contract';
import type { Session } from '@/catalog';
import type { HerdPane } from './herd';

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

/** The one rule for "needs you now": every Home surface asks it of an agent's current status. */
export function statusNeedsYou(status: AgentLifecycle): status is 'blocked' | 'failed' {
    return status === 'blocked' || status === 'failed';
}

/** The one rule for an agent: its status needs you, or it holds a pending request. */
export function agentNeedsYou(status: AgentLifecycle, pendingRequest = false): boolean {
    return pendingRequest || statusNeedsYou(status);
}

/** Sessions an online agent is holding a request for: their agent needs you whatever its pane says. */
export function pendingRequestSessionIds(
    sessions: readonly (Pick<Session, 'id'> & Partial<Pick<Session, 'presence' | 'agentState'>>)[],
): Set<string> {
    const pending = new Set<string>();
    for (const session of sessions) {
        const requests = session.agentState?.requests;
        if (session.presence === 'online' && requests != null && Object.keys(requests).length > 0) pending.add(session.id);
    }
    return pending;
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

/**
 * Unseen meaningful transitions only; latest event wins when one agent changed
 * repeatedly. `wanted` filters after that latest-wins pick and before the limit,
 * so rows a caller never shows cannot use up its slots.
 */
export function unseenActivityRows(
    events: readonly LifecycleEvent[],
    seenEventIds: ReadonlySet<string>,
    now = Date.now(),
    limit = 8,
    liveTitles?: ReadonlyMap<string, string>,
    wanted: (row: RecentActivityRow) => boolean = () => true,
): RecentActivityRow[] {
    const latestRoutes = new Set<string>();
    const rows: RecentActivityRow[] = [];
    for (const event of events) {
        if (!VISIBLE_STATES.has(event.state) || latestRoutes.has(event.sessionId)) continue;
        latestRoutes.add(event.sessionId);
        if (seenEventIds.has(event.eventId)) continue;
        const at = Date.parse(event.at);
        if (!Number.isFinite(at) || now - at > MAX_AGE_MS) continue;
        const row: RecentActivityRow = {
            eventId: event.eventId,
            sessionId: event.sessionId,
            taskTitle: resolveActivityTaskTitle(event, liveTitles?.get(event.sessionId)),
            agentName: lifecycleEventAgentName(event),
            ...(event.agentKind === undefined ? {} : { agentKind: event.agentKind }),
            status: event.state as RecentActivityRow['status'],
            reasonCode: event.reasonCode,
            at,
        };
        if (!wanted(row)) continue;
        rows.push(row);
        if (rows.length === limit) break;
    }
    return rows;
}

/**
 * The Needs you tier: one row per agent that needs you now (needsYouSessionIds),
 * newest first. A row leaves only when its agent stops needing you, never
 * because it was seen, so the tier, the Spaces count and the badge agree.
 */
export function needsYouActivityRows(
    needsYou: ReadonlySet<string>,
    panes: readonly Pick<HerdPane, 'id' | 'agentName' | 'taskTitle' | 'agentKind' | 'agentStatus' | 'changedAt'>[],
    events: readonly LifecycleEvent[],
    now = Date.now(),
): RecentActivityRow[] {
    const panesById = new Map(panes.map((pane) => [pane.id, pane]));
    const current = [...needsYou].map((sessionId): RecentActivityRow => {
        const pane = panesById.get(sessionId);
        const latest = events.find((event) => event.sessionId === sessionId);
        // A pending request with no blocked or failed pane still needs an answer.
        const status = pane !== undefined && statusNeedsYou(pane.agentStatus) ? pane.agentStatus : 'blocked';
        const event = latest?.state === status ? latest : undefined;
        const at = event === undefined ? Number.NaN : Date.parse(event.at);
        const agentName = pane?.agentName ?? (latest === undefined ? undefined : lifecycleEventAgentName(latest));
        const agentKind = pane?.agentKind ?? latest?.agentKind;
        return {
            eventId: event?.eventId ?? `needs-you:${sessionId}`,
            sessionId,
            taskTitle: latest === undefined
                ? pane?.taskTitle ?? pane?.agentName ?? ''
                : resolveActivityTaskTitle(latest, pane?.taskTitle),
            ...(agentName === undefined ? {} : { agentName }),
            ...(agentKind === undefined ? {} : { agentKind }),
            status,
            reasonCode: event?.reasonCode ?? '',
            at: Number.isFinite(at) ? at : pane?.changedAt ?? now,
        };
    });
    return current.sort((left, right) => right.at - left.at);
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
    return new Set(unseenActivityRows(events, seenEventIds, now, 8, undefined, (row) => row.status === 'done')
        .map((row) => row.sessionId));
}
