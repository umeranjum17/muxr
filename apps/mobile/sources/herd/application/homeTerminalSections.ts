import type { HerdrTreeWorkspace, LifecycleEvent } from '@trymuxr/contract';
import { needsYouActivityRows, unseenActivityRows, agentNeedsYou, type RecentActivityRow } from '../domain/recentActivity';
import type { LiveTerminalOrderCard } from './liveTerminalOrder';

export const HOME_SECTION_DWELL_MS = 1_500;
type Section = 'live' | 'needs-you' | 'ready' | 'failed';
interface HomeTerminalEntry {
    key: string;
    card?: LiveTerminalOrderCard;
    activity?: RecentActivityRow;
    paneId?: string;
    workspaceId?: string;
    routes: readonly string[];
    section: Section;
    pending?: { section: Section | 'gone'; since: number };
}
export interface HomeTerminalSections {
    entries: readonly HomeTerminalEntry[];
    settlesAt?: number;
}
export const EMPTY_HOME_TERMINAL_SECTIONS: HomeTerminalSections = { entries: [] };

/** One Home-only owner per agent. Routes still authorize; names only match a
 * replacement picture within its workspace, never a navigation target. */
export function homeTerminalSections(
    previous: HomeTerminalSections,
    cards: readonly LiveTerminalOrderCard[],
    workspaces: readonly HerdrTreeWorkspace[],
    events: readonly LifecycleEvent[],
    seen: ReadonlySet<string>,
    now: number,
    requests: readonly RecentActivityRow[] = [],
): HomeTerminalSections {
    const locations = new Map(workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) =>
        tab.panes.flatMap((pane) => pane.sessionId === undefined ? [] : [[pane.sessionId, { paneId: pane.paneId, workspaceId: workspace.workspaceId }] as const]))));
    const latest = new Map<string, LifecycleEvent>();
    for (const event of events) if (!latest.has(event.sessionId)) latest.set(event.sessionId, event);
    // Include working/starting in latest-wins BEFORE filtering meaningful outcomes.
    const unseen = unseenActivityRows([...latest.values()], seen, now, Number.MAX_SAFE_INTEGER);
    const outcomes = new Map(unseen.map((row) => [row.sessionId, row]));
    const currentByAgent = new Map<string, LiveTerminalOrderCard>();
    for (const card of cards) {
        const location = locations.get(card.id);
        const identity = card.agentName === undefined ? card.id : JSON.stringify([location?.workspaceId, card.agentKind, card.agentName]);
        const held = currentByAgent.get(identity);
        if (held === undefined || (card.changedAt ?? 0) >= (held.changedAt ?? 0)) currentByAgent.set(identity, card);
    }
    const currentCards = [...currentByAgent.values()];
    const candidates: HomeTerminalEntry[] = [];
    const used = new Set<string>();
    for (const card of currentCards) {
        const location = locations.get(card.id);
        const before = previous.entries.find((entry) => !used.has(entry.key) && (
            entry.routes.includes(card.id)
            || (location !== undefined && entry.paneId === location.paneId)
            || (location !== undefined && entry.workspaceId === location.workspaceId
                && card.agentName !== undefined && entry.card?.agentName === card.agentName
                && entry.card.agentKind === card.agentKind
                && !currentCards.some((current) => current.id === entry.card?.id))
        ));
        const outcome = outcomes.get(card.id);
        let section: Section = 'live';
        let activity: RecentActivityRow | undefined;
        if (agentNeedsYou(card.agentStatus, card.pendingRequest)) {
            section = 'needs-you';
            activity = needsYouActivityRows(new Set([card.id]), [card], events, now)[0];
        } else if ((card.agentStatus === 'done' || card.agentStatus === 'idle') && outcome?.status === 'done') {
            section = 'ready';
            activity = outcome;
        }
        if (activity !== undefined) activity = { ...activity, taskTitle: card.taskTitle ?? activity.taskTitle, agentName: card.agentName ?? activity.agentName };
        const key = before?.key ?? card.id;
        used.add(key);
        candidates.push({ key, card, activity, ...location,
            // ponytail: retain eight route generations per mounted card; names
            // also suppress older departed notices. Expand only if real churn needs it.
            routes: [...new Set([...(before?.routes ?? []), card.id])].slice(-8), section });
    }
    // A request without a listed agent (including a shell) must stay answerable.
    for (const activity of requests) {
        if (candidates.some((entry) => entry.routes.includes(activity.sessionId)
            || (activity.agentName !== undefined && entry.card?.agentName === activity.agentName && entry.card.agentKind === activity.agentKind))) continue;
        // A request can outlive its tree pane; keep the replacement identity.
        const before = previous.entries.find((entry) => entry.routes.includes(activity.sessionId));
        const key = before?.key ?? activity.sessionId;
        used.add(key);
        candidates.push({ ...before, key, activity, routes: before?.routes ?? [activity.sessionId], pending: undefined, section: 'needs-you' });
    }
    for (const activity of unseen) {
        // A present generation owns its history; an old done never competes
        // with a currently working/blocked agent, even after a title change.
        const rawName = latest.get(activity.sessionId)?.agentName;
        const represented = candidates.some((entry) => entry.routes.includes(activity.sessionId)
            || (rawName !== undefined && entry.card?.agentName === rawName && entry.card.agentKind === activity.agentKind)
            || (rawName !== undefined && entry.activity !== undefined
                && latest.get(entry.activity.sessionId)?.agentName === rawName && entry.activity.agentKind === activity.agentKind));
        if (represented || (activity.status !== 'done' && activity.status !== 'failed')) continue;
        const before = previous.entries.find((entry) => entry.routes.includes(activity.sessionId));
        const key = before?.key ?? activity.sessionId;
        if (used.has(key)) continue;
        used.add(key);
        candidates.push({ ...before, key, activity, routes: before?.routes ?? [activity.sessionId], pending: undefined, section: activity.status === 'done' ? 'ready' : 'failed' });
    }
    const entries: HomeTerminalEntry[] = [];
    let settlesAt: number | undefined;
    const hold = (entry: HomeTerminalEntry) => {
        entries.push(entry);
        if (entry.pending !== undefined) settlesAt = Math.min(settlesAt ?? Infinity, entry.pending.since + HOME_SECTION_DWELL_MS);
    };
    for (const candidate of candidates) {
        const before = previous.entries.find((entry) => entry.key === candidate.key);
        if (before === undefined || before.section === candidate.section) {
            hold(candidate);
            continue;
        }
        const pending = before.pending?.section === candidate.section ? before.pending : { section: candidate.section, since: now };
        if (now - pending.since >= HOME_SECTION_DWELL_MS) hold(candidate);
        else hold({ ...candidate, section: before.section,
            activity: before.activity === undefined ? undefined : { ...before.activity, sessionId: candidate.card?.id ?? before.activity.sessionId },
            card: candidate.card === undefined ? before.card : { ...candidate.card,
                agentStatus: before.card?.agentStatus ?? candidate.card.agentStatus, pendingRequest: before.card?.pendingRequest }, pending });
    }
    for (const before of previous.entries) {
        if (used.has(before.key)) continue;
        const pending = before.pending?.section === 'gone' ? before.pending : { section: 'gone' as const, since: now };
        if (now - pending.since < HOME_SECTION_DWELL_MS) hold({ ...before, pending });
    }
    return { entries, settlesAt };
}
