import type { AgentLifecycle } from '@muxr/contract';
import type { Session } from '@/catalog';
import { paneStatus, type HerdPane } from '../domain/herd';

export const RECENTLY_DONE_SWIPE_MS = 2 * 60_000;
export const RECENTLY_DONE_DISPLAY_MS = 30 * 60_000;

export type LiveTerminalBucket = 'attention' | 'working' | 'settled' | 'offline';

export interface LiveTerminalOrderCard {
    session: Session;
    status: AgentLifecycle;
    title?: string;
    changedAt: number;
}

/** Join display metadata onto canonical panes; lifecycle stays tree-owned. */
export function selectLiveTerminalCards(
    sessions: readonly Session[],
    panes: readonly HerdPane[],
): LiveTerminalOrderCard[] {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    return panes.flatMap((pane) => {
        const session = sessionsById.get(pane.id);
        return session === undefined ? [] : [{
            session,
            status: pane.status,
            title: pane.taskTitle,
            changedAt: pane.changedAt,
        }];
    });
}

export function liveTerminalBucket(status: AgentLifecycle): LiveTerminalBucket {
    if (status === 'blocked' || status === 'failed') return 'attention';
    if (status === 'working' || status === 'starting') return 'working';
    if (status === 'done' || status === 'idle') return 'settled';
    return 'offline';
}

const STATUS_ORDER: Record<AgentLifecycle, number> = {
    blocked: 0,
    failed: 1,
    working: 2,
    starting: 3,
    done: 4,
    idle: 5,
    unknown: 6,
};

/** Needs-you first, active work next, then recent completions and offline panes. */
export function orderLiveTerminalCards(
    cards: readonly LiveTerminalOrderCard[],
    now = Date.now(),
): LiveTerminalOrderCard[] {
    return cards
        .filter((card) => card.status !== 'done' || now - card.changedAt <= RECENTLY_DONE_DISPLAY_MS)
        .sort((left, right) => {
            const status = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
            if (status !== 0) return status;
            const time = left.status === 'blocked'
                ? left.changedAt - right.changedAt
                : right.changedAt - left.changedAt;
            return time || left.session.id.localeCompare(right.session.id);
        });
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
