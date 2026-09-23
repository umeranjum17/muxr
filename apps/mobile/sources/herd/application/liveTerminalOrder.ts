import type { AgentInfo, AgentLifecycle } from '@muxr/contract';
import type { Session } from '@/catalog';
import type { HerdPane } from '../domain/herd';
import { agentLabels, isShellLabels } from '../domain/agentPresentation';
import type { RecentActivityRow } from '../domain/recentActivity';

export const RECENTLY_DONE_SWIPE_MS = 2 * 60_000;

export type LiveTerminalBucket = 'attention' | 'working' | 'settled' | 'offline';

export interface LiveTerminalOrderCard extends AgentInfo {
    id: string;
    session?: Session;
    changedAt?: number;
    createdAt?: number;
}

/** Tree panes are canonical; the session catalog only enriches their previews. Bare shells never make the strip: LIVE is agents only. */
export function selectLiveTerminalCards(
    sessions: readonly Session[],
    panes: readonly HerdPane[],
): LiveTerminalOrderCard[] {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    return panes.filter((pane) => !isShellLabels(agentLabels(pane))).map((pane) => {
        const session = sessionsById.get(pane.id);
        return {
            id: pane.id,
            session,
            ...(pane.agentName === undefined ? {} : { agentName: pane.agentName }),
            ...(pane.taskTitle === undefined ? {} : { taskTitle: pane.taskTitle }),
            ...(pane.agentKind === undefined ? {} : { agentKind: pane.agentKind }),
            ...(pane.displayAgent === undefined ? {} : { displayAgent: pane.displayAgent }),
            agentStatus: pane.agentStatus,
            promptable: pane.promptable,
            changedAt: pane.changedAt,
            createdAt: session?.createdAt,
        };
    });
}

export function liveTerminalBucket(status: AgentLifecycle): LiveTerminalBucket {
    if (status === 'blocked' || status === 'failed') return 'attention';
    if (status === 'working' || status === 'starting') return 'working';
    if (status === 'done' || status === 'idle') return 'settled';
    return 'offline';
}

/** A terminal is a place, not an event: lifecycle changes never move its card. */
export function orderLiveTerminalCards(cards: readonly LiveTerminalOrderCard[]): LiveTerminalOrderCard[] {
    return [...cards].sort((left, right) =>
        (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER));
}

function sameCard(left: LiveTerminalOrderCard, right: LiveTerminalOrderCard): boolean {
    return left.id === right.id
        && left.session === right.session
        && left.agentStatus === right.agentStatus
        && left.taskTitle === right.taskTitle
        && left.agentName === right.agentName
        && left.agentKind === right.agentKind
        && left.displayAgent === right.displayAgent
        && left.changedAt === right.changedAt
        && left.createdAt === right.createdAt;
}

/**
 * Preserve every surviving slot when metadata arrives or lifecycle changes.
 * New panes append in creation order, so a late catalog join cannot reshuffle
 * the strip the user is already looking at.
 */
export function reconcileLiveTerminalCards(
    previous: readonly LiveTerminalOrderCard[],
    current: readonly LiveTerminalOrderCard[],
): readonly LiveTerminalOrderCard[] {
    const currentById = new Map(current.map((card) => [card.id, card]));
    const existing = previous.flatMap((card) => {
        const updated = currentById.get(card.id);
        if (updated === undefined) return [];
        currentById.delete(card.id);
        // One changed session used to hand every card a new object, so every
        // React.memo card re-rendered on each host info frame. Cards that did
        // not change keep their previous object and stay memoized.
        return [sameCard(card, updated) ? card : updated];
    });
    const next = [...existing, ...orderLiveTerminalCards([...currentById.values()])];
    const unchanged = next.length === previous.length
        && next.every((card, index) => card === previous[index]);
    return unchanged ? previous : next;
}

export interface ActivityAcknowledgementViewport {
    focused: boolean;
    foreground: boolean;
    viewportTop: number;
    viewportBottom: number;
    stripTop: number;
    stripHeight: number;
    scrollX: number;
    stripWidth: number;
    cardWidth: number;
    cardGap: number;
    gutter: number;
}

/** Needs-you activity becomes seen only while its entire terminal card is actually visible. Done outcomes clear on open instead (TerminalRoute acks), never by scrolling past. */
export function visibleActivityEventIds(
    rows: readonly RecentActivityRow[],
    cards: readonly LiveTerminalOrderCard[],
    viewport: ActivityAcknowledgementViewport,
): string[] {
    if (!viewport.focused || !viewport.foreground) return [];
    if (viewport.stripTop < viewport.viewportTop) return [];
    if (viewport.stripTop + viewport.stripHeight > viewport.viewportBottom) return [];

    const visibleRoutes = new Set(cards.flatMap((card, index) => {
        const start = viewport.gutter + index * (viewport.cardWidth + viewport.cardGap);
        const end = start + viewport.cardWidth;
        return start >= viewport.scrollX && end <= viewport.scrollX + viewport.stripWidth ? [card.id] : [];
    }));
    return rows.filter((row) => visibleRoutes.has(row.sessionId)).map((row) => row.eventId);
}

/** Which agents the terminal swipe pages through. */
export type AgentSwipeScope = 'working' | 'all';

export interface AgentSwipeNeighbours {
    previous?: LiveTerminalOrderCard;
    next?: LiveTerminalOrderCard;
}

function swipeStop(card: LiveTerminalOrderCard, scope: AgentSwipeScope, now: number): boolean {
    if (scope === 'all') return true;
    const status = card.agentStatus;
    return status === 'working' || status === 'starting' || status === 'blocked'
        || (status === 'done' && card.changedAt !== undefined && now - card.changedAt <= RECENTLY_DONE_SWIPE_MS);
}

/**
 * The agents either side of the open one, in the Live strip's own left-to-right
 * order. A pager whose pages reorder themselves when an agent changes state
 * cannot be learned -- swiping back must return to where you came from -- so
 * the order is the strip's, which never moves a card for its lifecycle. The
 * scope only decides which of those agents the swipe stops at. There is no
 * wrap: the first and last agent are ends, and the pager says so by resisting.
 */
export function agentSwipeNeighbours(
    cards: readonly LiveTerminalOrderCard[],
    currentId: string,
    scope: AgentSwipeScope,
    now = Date.now(),
): AgentSwipeNeighbours {
    const ordered = orderLiveTerminalCards(cards);
    const index = ordered.findIndex((card) => card.id === currentId);
    const stops = (from: readonly LiveTerminalOrderCard[]) =>
        from.find((card) => card.id !== currentId && swipeStop(card, scope, now));
    // A pane outside the strip (a shell) sits before its first agent.
    if (index === -1) return { next: stops(ordered) };
    return {
        previous: stops(ordered.slice(0, index).reverse()),
        next: stops(ordered.slice(index + 1)),
    };
}
