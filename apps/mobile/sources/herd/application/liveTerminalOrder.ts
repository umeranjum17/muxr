import * as React from 'react';
import type { AgentLifecycle } from '@muxr/contract';
import type { Session } from '@/sync/storageTypes';
import { HERD_ORDER, paneStatus, type HerdPane } from '../domain/herd';

export const LIVE_TERMINAL_REEVALUATION_MS = 30_000;
export const RECENTLY_DONE_SWIPE_MS = 2 * 60_000;

export interface LiveTerminalOrderCard {
    session: Session;
    status: AgentLifecycle;
    title?: string;
}

export interface LiveTerminalOrderState {
    ids: readonly string[];
    nextReevaluationAt: number;
}

/** Join display metadata onto the canonical panes; lifecycle stays tree-owned. */
export function selectLiveTerminalCards(
    sessions: readonly Session[],
    panes: readonly HerdPane[],
): LiveTerminalOrderCard[] {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    return panes.flatMap((pane) => {
        const session = sessionsById.get(pane.id);
        return session === undefined ? [] : [{ session, status: pane.status, title: pane.taskTitle }];
    });
}

function compareIds(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}
function compareCards(left: LiveTerminalOrderCard, right: LiveTerminalOrderCard): number {
    const titleOrder = left.title !== undefined && right.title !== undefined
        ? left.title.localeCompare(right.title)
        : 0;
    return HERD_ORDER[left.status] - HERD_ORDER[right.status]
        || titleOrder
        || right.session.updatedAt - left.session.updatedAt
        || compareIds(left.session.id, right.session.id);
}

function sortIds(cards: readonly LiveTerminalOrderCard[]): string[] {
    return [...cards].sort(compareCards).map((card) => card.session.id);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
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
                || compareIds(left.id, right.id);
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

/**
 * Apply changes that must be visible without waiting for the dwell window:
 * closed panes leave, new panes append, and active panes move to the front.
 * Same-status cards keep their existing positions.
 */
function immediateIds(previousIds: readonly string[], cards: readonly LiveTerminalOrderCard[]): string[] {
    const byId = new Map(cards.map((card) => [card.session.id, card]));
    const ids = previousIds.filter((id) => byId.has(id));
    if (ids.length === 0) return sortIds(cards);

    const known = new Set(ids);
    const newIds = cards
        .filter((card) => !known.has(card.session.id))
        .sort((left, right) => compareIds(left.session.id, right.session.id))
        .map((card) => card.session.id);
    ids.push(...newIds);

    const blocked = ids.filter((id) => byId.get(id)?.status === 'blocked');
    const working = ids.filter((id) => byId.get(id)?.status === 'working');
    return [...blocked, ...working, ...ids.filter((id) => {
        const status = byId.get(id)?.status;
        return status !== 'blocked' && status !== 'working';
    })];
}

export function createLiveTerminalOrderState(
    cards: readonly LiveTerminalOrderCard[],
    now = Date.now(),
): LiveTerminalOrderState {
    return {
        ids: sortIds(cards),
        nextReevaluationAt: now + LIVE_TERMINAL_REEVALUATION_MS,
    };
}

export function reconcileLiveTerminalOrder(
    previous: LiveTerminalOrderState,
    cards: readonly LiveTerminalOrderCard[],
    now = Date.now(),
): LiveTerminalOrderState {
    const ids = immediateIds(previous.ids, cards);
    const currentIds = new Set(cards.map((card) => card.session.id));
    const hasExistingCard = previous.ids.some((id) => currentIds.has(id));
    const nextReevaluationAt = cards.length > 0 && !hasExistingCard
        ? now + LIVE_TERMINAL_REEVALUATION_MS
        : previous.nextReevaluationAt;

    if (sameIds(previous.ids, ids) && nextReevaluationAt === previous.nextReevaluationAt) return previous;
    return { ids, nextReevaluationAt };
}

export function reevaluateLiveTerminalOrder(
    previous: LiveTerminalOrderState,
    cards: readonly LiveTerminalOrderCard[],
    now = Date.now(),
): LiveTerminalOrderState {
    const byId = new Map(cards.map((card) => [card.session.id, card]));
    // Stable regroup: a status-class change moves a card, but updatedAt churn
    // among same-status cards must not -- with several agents streaming, the
    // row visibly shuffled left-right on every reevaluation window.
    // (Array.sort is stable, so equal-status cards keep their relative order.)
    const kept = previous.ids
        .filter((id) => byId.has(id))
        .sort((left, right) => HERD_ORDER[byId.get(left)!.status] - HERD_ORDER[byId.get(right)!.status]);
    const known = new Set(kept);
    const fresh = cards
        .filter((card) => !known.has(card.session.id))
        .sort((left, right) => compareIds(left.session.id, right.session.id))
        .map((card) => card.session.id);
    return {
        ids: [...kept, ...fresh],
        nextReevaluationAt: now + LIVE_TERMINAL_REEVALUATION_MS,
    };
}

/** One row-level dwell timer; cards themselves never own an interval. */
export function useLiveTerminalOrder(cards: readonly LiveTerminalOrderCard[]): LiveTerminalOrderCard[] {
    const [state, setState] = React.useState(() => createLiveTerminalOrderState(cards));
    const cardsRef = React.useRef(cards);
    cardsRef.current = cards;

    React.useEffect(() => {
        setState((previous) => reconcileLiveTerminalOrder(previous, cards));
    }, [cards]);

    React.useEffect(() => {
        if (cards.length === 0) return;
        const delay = Math.max(0, state.nextReevaluationAt - Date.now());
        const timer = setTimeout(() => {
            setState((previous) => reevaluateLiveTerminalOrder(previous, cardsRef.current));
        }, delay);
        return () => clearTimeout(timer);
    }, [cards.length, state.ids.length, state.nextReevaluationAt]);

    const byId = new Map(cards.map((card) => [card.session.id, card]));
    return immediateIds(state.ids, cards)
        .map((id) => byId.get(id))
        .filter((card): card is LiveTerminalOrderCard => card !== undefined);
}
