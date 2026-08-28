import { describe, expect, it } from 'vitest';
import type { LifecycleEvent } from '@muxr/contract';
import type { Session } from '@/catalog';
import { recentActivityRows } from '../domain/recentActivity';
import {
    nextWorkingAgentId,
    orderLiveTerminalCards,
    workingAgentSwipeIds,
    type LiveTerminalOrderCard,
} from './liveTerminalOrder';

function session(id: string, changedAt: number, status: LiveTerminalOrderCard['status']): Session {
    return {
        id,
        updatedAt: changedAt,
        presence: 'online',
        metadata: { agentStatus: status, lifecycleStateSince: changedAt },
    } as Session;
}

function card(id: string, changedAt: number, status: LiveTerminalOrderCard['status']): LiveTerminalOrderCard {
    return { session: session(id, changedAt, status), status, changedAt };
}

describe('agent lifecycle presentation', () => {
    it('orders needs-you, working, and recently-done agents without title churn', () => {
        const now = 2_000_000;
        const cards = orderLiveTerminalCards([
            card('stale-done', now - 31 * 60_000, 'done'),
            card('working-new', now - 1_000, 'working'),
            card('blocked-new', now - 2_000, 'blocked'),
            card('done', now - 5_000, 'done'),
            card('blocked-old', now - 20_000, 'blocked'),
            card('working-old', now - 10_000, 'working'),
        ], now);

        expect(cards.map(({ session: item }) => item.id)).toEqual([
            'blocked-old',
            'blocked-new',
            'working-new',
            'working-old',
            'done',
        ]);
    });

    it('collapses activity by agent and removes working/unknown noise', () => {
        const event = (eventId: string, sessionId: string, state: LifecycleEvent['state'], at: string): LifecycleEvent => ({
            eventId,
            sessionId,
            displayName: 'Adam',
            taskTitle: 'Fix realtime voice',
            state,
            reasonCode: 'state-reconciled',
            reason: 'state-reconciled',
            at,
        });
        const rows = recentActivityRows([
            event('new', 'one', 'done', '2026-01-02T00:00:00.000Z'),
            event('duplicate', 'one', 'blocked', '2026-01-01T23:59:00.000Z'),
            event('working', 'two', 'working', '2026-01-01T23:58:00.000Z'),
            event('unknown', 'three', 'unknown', '2026-01-01T23:57:00.000Z'),
            event('failed', 'four', 'failed', '2026-01-01T23:56:00.000Z'),
        ]);

        expect(rows.map((row) => [row.eventId, row.status])).toEqual([
            ['new', 'done'],
            ['failed', 'failed'],
        ]);
    });

    it('keeps swipe navigation on active and two-minute-recent agents', () => {
        const now = 300_000;
        const ids = workingAgentSwipeIds([
            session('old', now - 120_001, 'done'),
            session('recent', now - 30_000, 'done'),
            session('idle', now, 'idle'),
            session('working', now - 5_000, 'working'),
            session('blocked', now, 'blocked'),
        ], now);

        expect(ids).toEqual(['blocked', 'working', 'recent']);
        expect(nextWorkingAgentId(ids, 'working', 1)).toBe('recent');
        expect(nextWorkingAgentId(ids, 'missing', -1)).toBe('recent');
    });
});
