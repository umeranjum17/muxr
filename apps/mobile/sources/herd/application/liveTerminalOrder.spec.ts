import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type { Session } from '@/catalog';
import {
    nextWorkingAgentId,
    useLiveTerminalOrder,
    workingAgentSwipeIds,
    type LiveTerminalOrderCard,
} from './liveTerminalOrder';

const act = TestRenderer.act;

type HarnessProps = { cards: readonly LiveTerminalOrderCard[] };

function session(id: string, updatedAt: number): Session {
    return {
        id,
        updatedAt,
        active: true,
        metadata: { agentStatus: 'working' },
    } as Session;
}

function card(id: string, updatedAt: number, status: LiveTerminalOrderCard['status'] = 'working') {
    return { session: session(id, updatedAt), status };
}

let renderedOrder = '';

function Harness({ cards }: HarnessProps) {
    const ordered = useLiveTerminalOrder(cards);
    renderedOrder = ordered.map((item) => item.session.id).join(',');
    return null;
}

describe('live terminal order', () => {
    let renderer: ReturnType<typeof TestRenderer.create> | null = null;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = null;
        vi.useRealTimers();
    });

    function render(cards: readonly LiveTerminalOrderCard[]) {
        act(() => {
            renderer = TestRenderer.create(React.createElement(Harness, { cards }));
        });
    }

    function update(cards: readonly LiveTerminalOrderCard[]) {
        act(() => {
            renderer?.update(React.createElement(Harness, { cards }));
        });
    }

    function order(): string {
        return renderedOrder;
    }

    it('holds working order through token churn, and reevaluation never shuffles same-status cards', () => {
        let cards = [card('a', 0), card('b', 0)];
        render(cards);
        expect(order()).toBe('a,b');

        for (let second = 1; second <= 29; second += 1) {
            cards = [
                card('a', second % 2 === 0 ? second * 1000 : 0),
                card('b', second % 2 === 1 ? second * 1000 : 0),
            ];
            update(cards);
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(order()).toBe('a,b');
        }

        // The 30s reevaluation regroups by status class only: both cards are
        // still working, so the updatedAt churn must not swap them.
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(order()).toBe('a,b');

        for (let second = 31; second <= 59; second += 1) {
            update([
                card('a', second % 2 === 0 ? second * 1000 : 0),
                card('b', second % 2 === 1 ? second * 1000 : 0),
            ]);
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(order()).toBe('a,b');
        }

        // A status-class change is what moves a card: b finishes, and the next
        // reevaluation regroups it behind the still-working a.
        vi.setSystemTime(61_000);
        update([card('a', 61_000, 'done'), card('b', 61_000)]);
        act(() => {
            vi.advanceTimersByTime(30_000);
        });
        expect(order()).toBe('b,a');
    });

    it('prioritizes active panes immediately and handles structural changes without churn', () => {
        render([card('a', 0, 'done'), card('b', 0, 'idle')]);
        expect(order()).toBe('a,b');

        vi.setSystemTime(10_000);
        update([card('a', 0, 'done'), card('b', 10_000)]);
        expect(order()).toBe('b,a');

        update([card('a', 20_000, 'blocked'), card('b', 20_000)]);
        expect(order()).toBe('a,b');

        update([card('a', 20_000)]);
        expect(order()).toBe('a');

        update([card('a', 20_000), card('c', 20_000)]);
        expect(order()).toBe('a,c');
    });

    it('builds one swipe buffer from working and two-minute-recent agents', () => {
        const now = 300_000;
        const swipeSession = (id: string, status: 'working' | 'blocked' | 'done' | 'idle', changedAt: number) => ({
            id,
            updatedAt: changedAt,
            presence: 'online',
            metadata: { agentStatus: status, lifecycleStateSince: changedAt },
        } as Session);
        const staleDoneButStreaming = swipeSession('streaming', 'done', now - 180_000);
        staleDoneButStreaming.thinking = true;
        const ids = workingAgentSwipeIds([
            swipeSession('old', 'done', now - 120_001),
            swipeSession('recent', 'done', now - 30_000),
            swipeSession('idle', 'idle', now),
            swipeSession('working', 'working', now - 5_000),
            staleDoneButStreaming,
            swipeSession('blocked', 'blocked', now),
        ], now);

        expect(ids).toEqual(['blocked', 'working', 'streaming', 'recent']);
        expect(nextWorkingAgentId(ids, 'working', 1)).toBe('streaming');
        expect(nextWorkingAgentId(ids, 'old', 1)).toBe('blocked');
        expect(nextWorkingAgentId(ids, 'old', -1)).toBe('recent');
    });

    it('uses deterministic ties across replacement renders and cleans its single timer', () => {
        render([card('z', 0), card('a', 0)]);
        expect(order()).toBe('a,z');
        expect(vi.getTimerCount()).toBe(1);

        update([card('z', 0), card('a', 0)]);
        expect(order()).toBe('a,z');

        act(() => renderer?.unmount());
        renderer = null;
        expect(vi.getTimerCount()).toBe(0);
    });
});
