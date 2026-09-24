import type { AgentInfo, AgentLifecycle } from '@muxr/contract';
import type { HerdPane } from '../domain/herd';
import { agentLabels, isShellLabels } from '../domain/agentPresentation';
import type { RecentActivityRow } from '../domain/recentActivity';

export const RECENTLY_DONE_SWIPE_MS = 2 * 60_000;

export type LiveTerminalBucket = 'attention' | 'working' | 'settled' | 'offline';

export interface LiveTerminalOrderCard extends AgentInfo {
    id: string;
    session?: { id: string; createdAt?: number };
    changedAt?: number;
    createdAt?: number;
}

/** Tree panes are canonical; the session catalog only enriches their previews. Bare shells never make the strip: LIVE is agents only. */
export function selectLiveTerminalCards(
    sessions: readonly { id: string; createdAt?: number }[],
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

/** Creation order: how cards first seen together take their stable slots. */
export function orderLiveTerminalCards(cards: readonly LiveTerminalOrderCard[]): LiveTerminalOrderCard[] {
    return [...cards].sort((left, right) =>
        (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER));
}

/**
 * How long a working agent must stay quiet before its card leaves the working
 * group. Herdr reports an agent idle for the moment between one tool call and
 * the next, and between a turn ending and a queued prompt starting; those
 * pauses run a few seconds. Ten seconds outlasts them, yet a finished agent
 * still steps back before anyone would go looking for it.
 */
export const LIVE_WORKING_DWELL_MS = 10_000;

/** Where a card stands: its group, when it joined that group, and its home slot. */
interface LiveTerminalStanding {
    bucket: LiveTerminalBucket;
    enteredAt: number;
    seq: number;
    quietSince?: number;
}

export interface LiveTerminalArrangement {
    cards: readonly LiveTerminalOrderCard[];
    standings: ReadonlyMap<string, LiveTerminalStanding>;
}

export const EMPTY_LIVE_TERMINAL_ARRANGEMENT: LiveTerminalArrangement = { cards: [], standings: new Map() };

// Idle, done and offline agents share one group: "the rest".
const BUCKET_RANK: Record<LiveTerminalBucket, number> = { attention: 0, working: 1, settled: 2, offline: 2 };

function nextStanding(previous: LiveTerminalStanding | undefined, card: LiveTerminalOrderCard, seq: number, now: number): LiveTerminalStanding {
    const bucket = liveTerminalBucket(card.agentStatus);
    if (previous === undefined) return { bucket, enteredAt: now, seq };
    if (previous.bucket === bucket) {
        return previous.quietSince === undefined ? previous : { bucket, enteredAt: previous.enteredAt, seq: previous.seq };
    }
    // Promotion is immediate; leaving the working group waits out the dwell.
    if (previous.bucket === 'working' && bucket !== 'attention') {
        const quietSince = previous.quietSince ?? now;
        if (now - quietSince < LIVE_WORKING_DWELL_MS) {
            return previous.quietSince === undefined ? { ...previous, quietSince } : previous;
        }
    }
    return { bucket, enteredAt: now, seq: previous.seq };
}

function compareStandings(left: LiveTerminalStanding, right: LiveTerminalStanding): number {
    const rank = BUCKET_RANK[left.bucket] - BUCKET_RANK[right.bucket];
    if (rank !== 0) return rank;
    // Needs-you and working agents queue by when they joined the group, never
    // by output, so two busy agents never trade places. The rest keep their slot.
    if (BUCKET_RANK[left.bucket] < 2 && left.enteredAt !== right.enteredAt) return left.enteredAt - right.enteredAt;
    return left.seq - right.seq;
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
 * Needs-you first, then working, then the rest. While `held` (a finger on the
 * strip, or an agent open in the pager) surviving cards keep their places and
 * newcomers join the end; the order catches up once the hold lifts.
 */
export function arrangeLiveTerminalCards(
    previous: LiveTerminalArrangement,
    current: readonly LiveTerminalOrderCard[],
    now: number,
    held = false,
): LiveTerminalArrangement {
    const previousById = new Map(previous.cards.map((card) => [card.id, card]));
    let seq = Math.max(-1, ...Array.from(previous.standings.values(), (standing) => standing.seq)) + 1;
    const standings = new Map<string, LiveTerminalStanding>();
    // Cards first seen together take home slots in creation order.
    for (const card of orderLiveTerminalCards(current.filter((card) => !previous.standings.has(card.id)))) {
        standings.set(card.id, nextStanding(undefined, card, seq++, now));
    }
    for (const card of current) {
        const standing = previous.standings.get(card.id);
        if (standing !== undefined) standings.set(card.id, nextStanding(standing, card, standing.seq, now));
    }
    // Cards that did not change keep their previous object and stay memoized.
    const byId = new Map(current.map((card) => {
        const before = previousById.get(card.id);
        return [card.id, before !== undefined && sameCard(before, card) ? before : card] as const;
    }));
    const slot = new Map(previous.cards.map((card, index) => [card.id, index]));
    const next = [...byId.values()].sort((left, right) => {
        if (held) {
            const placed = (slot.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (slot.get(right.id) ?? Number.MAX_SAFE_INTEGER);
            if (placed !== 0) return placed;
            return standings.get(left.id)!.seq - standings.get(right.id)!.seq;
        }
        return compareStandings(standings.get(left.id)!, standings.get(right.id)!);
    });
    const unchanged = next.length === previous.cards.length
        && next.every((card, index) => card === previous.cards[index]);
    return { cards: unchanged ? previous.cards : next, standings };
}

/** When a quiet working agent's dwell runs out and the order must be read again. */
export function liveTerminalOrderSettlesAt(arrangement: LiveTerminalArrangement): number | undefined {
    let earliest: number | undefined;
    for (const standing of arrangement.standings.values()) {
        if (standing.quietSince === undefined) continue;
        const at = standing.quietSince + LIVE_WORKING_DWELL_MS;
        if (earliest === undefined || at < earliest) earliest = at;
    }
    return earliest;
}

// Home's strip and the terminal pager read one arrangement, so paging from an
// agent walks the same order the strip showed.
let strip = EMPTY_LIVE_TERMINAL_ARRANGEMENT;
let holds = 0;
const orderListeners = new Set<() => void>();

export function sharedLiveTerminalCards(
    candidate: readonly LiveTerminalOrderCard[],
    now = Date.now(),
): readonly LiveTerminalOrderCard[] {
    strip = arrangeLiveTerminalCards(strip, candidate, now, holds > 0);
    return strip.cards;
}

export function sharedLiveTerminalOrderSettlesAt(): number | undefined {
    return liveTerminalOrderSettlesAt(strip);
}

/** Freeze the strip's order until the returned release is called. */
export function holdLiveTerminalOrder(): () => void {
    holds += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0) for (const listener of orderListeners) listener();
    };
}

/** Called when the last hold lifts, so the strip can apply the order it deferred. */
export function subscribeLiveTerminalOrder(listener: () => void): () => void {
    orderListeners.add(listener);
    return () => { orderListeners.delete(listener); };
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

/** Which agents the terminal swipe stops at: active/recent agents, or every agent in the strip. */
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
 * an open agent holds the strip's order (holdLiveTerminalOrder) for as long
 * as it is on screen. The lifecycle decides which of those agents the swipe stops at. There is no
 * wrap: the first and last agent are ends, and the pager says so by resisting.
 */
export function agentSwipeNeighbours(
    cards: readonly LiveTerminalOrderCard[],
    currentId: string,
    scope: AgentSwipeScope,
    now = Date.now(),
): AgentSwipeNeighbours {
    const index = cards.findIndex((card) => card.id === currentId);
    const stops = (from: readonly LiveTerminalOrderCard[]) =>
        from.find((card) => card.id !== currentId && swipeStop(card, scope, now));
    if (index === -1) return { previous: stops([...cards].reverse()), next: stops(cards) };
    return {
        previous: stops(cards.slice(0, index).reverse()),
        next: stops(cards.slice(index + 1)),
    };
}
