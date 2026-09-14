import type { AgentInfo, AgentLifecycle } from '@muxr/contract';
import type { Session } from '@/catalog';
import { paneStatus, type HerdPane } from '../domain/herd';
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

function priority(card: LiveTerminalOrderCard, unseen: ReadonlySet<string>): number {
    if (card.agentStatus === 'blocked' || card.agentStatus === 'failed') return 0;
    if (unseen.has(card.id)) return 1;
    if (card.agentStatus === 'working' || card.agentStatus === 'starting') return 2;
    if (card.agentStatus === 'done' || card.agentStatus === 'idle') return 3;
    return 4;
}

/** Verified lifecycle and unseen activity put agents needing a look before active and settled agents. */
export function orderLiveTerminalCards(cards: readonly LiveTerminalOrderCard[], unseen: ReadonlySet<string> = new Set()): LiveTerminalOrderCard[] {
    return [...cards].sort((left, right) => priority(left, unseen) - priority(right, unseen)
        || (right.changedAt ?? 0) - (left.changedAt ?? 0)
        || left.id.localeCompare(right.id));
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
 * Preserve unchanged card objects while placing live cards in priority order.
 */
export function reconcileLiveTerminalCards(
    previous: readonly LiveTerminalOrderCard[],
    current: readonly LiveTerminalOrderCard[],
    unseen: ReadonlySet<string> = new Set(),
): readonly LiveTerminalOrderCard[] {
    const previousById = new Map(previous.map((card) => [card.id, card]));
    const next = orderLiveTerminalCards(current, unseen).map((card) => {
        const before = previousById.get(card.id);
        return before !== undefined && sameCard(before, card) ? before : card;
    });
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

/** Activity becomes seen only while its entire terminal card is actually visible. */
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

/** The one-swipe buffer: active agents, then agents that finished very recently. */
export function workingAgentSwipeIds(sessions: readonly Session[], now = Date.now()): string[] {
    return sessions
        .filter((session) => session.presence === 'online')
        .map((session) => ({
            id: session.id,
            status: paneStatus(session),
            changedAt: session.metadata?.lifecycleStateSince ?? session.updatedAt,
        }))
        .filter(({ status, changedAt }) =>
            status === 'working'
            || status === 'blocked'
            || (status === 'done' && now - changedAt <= RECENTLY_DONE_SWIPE_MS),
        )
        .sort((left, right) => {
            const leftActive = left.status === 'working' || left.status === 'blocked';
            const rightActive = right.status === 'working' || right.status === 'blocked';
            return Number(rightActive) - Number(leftActive)
                || right.changedAt - left.changedAt
                || left.id.localeCompare(right.id);
        })
        .map(({ id }) => id);
}

export function nextWorkingAgentId(
    ids: readonly string[],
    currentId: string,
    step: 1 | -1,
): string | undefined {
    if (ids.length === 0) return undefined;
    const index = ids.indexOf(currentId);
    if (index === -1) return step === 1 ? ids[0] : ids.at(-1);
    if (ids.length === 1) return undefined;
    return ids[(index + step + ids.length) % ids.length];
}
