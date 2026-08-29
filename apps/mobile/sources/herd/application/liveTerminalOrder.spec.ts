import { describe, expect, it } from 'vitest';
import type { LifecycleEvent } from '@muxr/contract';
import type { Session } from '@/catalog';
import type { HerdPane } from '../domain/herd';
import { agentAccessibilityLabel, agentLabels, agentStateLabel } from '../domain/agentPresentation';
import { unseenActivityRows, type RecentActivityRow } from '../domain/recentActivity';
import {
    nextWorkingAgentId,
    orderLiveTerminalCards,
    reconcileLiveTerminalCards,
    selectLiveTerminalCards,
    visibleActivityEventIds,
    workingAgentSwipeIds,
    type LiveTerminalOrderCard,
} from './liveTerminalOrder';

function session(
    id: string,
    changedAt: number,
    status: LiveTerminalOrderCard['status'],
    createdAt = changedAt,
): Session {
    return {
        id,
        createdAt,
        updatedAt: changedAt,
        presence: 'online',
        metadata: { agentStatus: status, lifecycleStateSince: changedAt },
    } as Session;
}

function card(
    id: string,
    changedAt: number,
    status: LiveTerminalOrderCard['status'],
    createdAt = changedAt,
): LiveTerminalOrderCard {
    return { id, session: session(id, changedAt, status, createdAt), status, title: id, name: 'Otter', agentKind: 'pi', changedAt, createdAt };
}

describe('agent lifecycle presentation', () => {
    it('keeps terminal slots in creation order across lifecycle changes and old completions', () => {
        const cards = orderLiveTerminalCards([
            card('done', 900, 'done', 100),
            card('blocked', 800, 'blocked', 300),
            card('working', 1_000, 'working', 200),
        ]);

        expect(cards.map((item) => item.id)).toEqual(['done', 'working', 'blocked']);
        expect(orderLiveTerminalCards(cards.map((item) => ({ ...item, status: 'done' })))
            .map((item) => item.id)).toEqual(['done', 'working', 'blocked']);
    });

    it('keeps terminal slots stable through catalog joins and equivalent snapshots', () => {
        const pane = (id: string, status: HerdPane['status'], changedAt?: number): HerdPane => ({
            id,
            name: `${id} agent`,
            taskTitle: `${id} task`,
            agentKind: 'pi',
            status,
            changedAt,
            doing: '',
        });
        const treeOnly = selectLiveTerminalCards([], [pane('first', 'working', 100), pane('second', 'blocked')]);
        expect(treeOnly.map((item) => [item.id, item.session])).toEqual([
            ['first', undefined],
            ['second', undefined],
        ]);
        expect(agentStateLabel(treeOnly[1]!.status, treeOnly[1]!.changedAt, 1_000_000)).toBe('Needs you');
        expect(agentLabels({
            taskTitle: treeOnly[0]!.title,
            agentName: treeOnly[0]!.name,
            agentKind: treeOnly[0]!.agentKind,
        }, treeOnly[0]!.session).agentName).toBe('first agent');

        const shell = selectLiveTerminalCards([], [{
            ...pane('shell', 'unknown'),
            name: 'Agent',
            agentKind: undefined,
        }])[0]!;
        const shellLabels = agentLabels({
            taskTitle: shell.title,
            agentName: shell.name,
            agentKind: shell.agentKind,
        }, shell.session);
        expect(shellLabels).toMatchObject({ taskTitle: 'shell task', agentName: 'Shell' });
        expect(agentAccessibilityLabel(shellLabels, shell.status, shell.changedAt)).toBe('shell task. Offline. Shell');

        const pending = session('pending', 300, 'starting');
        pending.metadata!.agentKind = 'omp';
        Object.assign(pending.metadata!, { agentName: 'Stale Otter', taskTitle: 'Stale task' });
        expect(agentLabels(undefined, pending)).toMatchObject({
            taskTitle: 'Untitled task',
            agentName: 'Agent',
            agentKind: 'omp',
        });

        const joined = reconcileLiveTerminalCards(treeOnly, selectLiveTerminalCards([
            session('second', 200, 'done', 20),
            session('first', 200, 'blocked', 10),
        ], [pane('first', 'blocked', 200), pane('second', 'done', 200)]));
        expect(joined.map((item) => [item.id, item.status, item.session?.id])).toEqual([
            ['first', 'blocked', 'first'],
            ['second', 'done', 'second'],
        ]);
        const equivalent = selectLiveTerminalCards(
            joined.flatMap((item) => item.session === undefined ? [] : [item.session]),
            [pane('first', 'blocked', 200), pane('second', 'done', 200)],
        );
        expect(reconcileLiveTerminalCards(joined, equivalent)).toBe(joined);
    });

    it('shows only unseen meaningful transitions from the last day, latest per agent', () => {
        const now = Date.parse('2026-01-02T00:00:00.000Z');
        const event = (eventId: string, sessionId: string, state: LifecycleEvent['state'], at: string): LifecycleEvent => ({
            eventId,
            sessionId,
            agentName: 'Otter',
            taskTitle: 'Fix realtime voice',
            state,
            reasonCode: 'state-reconciled',
            reason: 'state-reconciled',
            at,
        });
        const rows = unseenActivityRows([
            event('seen', 'seen-agent', 'done', '2026-01-01T23:59:30.000Z'),
            event('latest', 'one', 'done', '2026-01-01T23:59:00.000Z'),
            event('older-same-agent', 'one', 'blocked', '2026-01-01T23:58:00.000Z'),
            event('working', 'two', 'working', '2026-01-01T23:57:00.000Z'),
            event('old', 'three', 'failed', '2025-12-31T23:00:00.000Z'),
            event('failed', 'four', 'failed', '2026-01-01T23:56:00.000Z'),
        ], new Set(['seen']), now);

        expect(rows.map((row) => [row.eventId, row.sessionId, row.agentName, row.status])).toEqual([
            ['latest', 'one', 'Otter', 'done'],
            ['failed', 'four', 'Otter', 'failed'],
        ]);

        expect(unseenActivityRows([
            event('seen', 'seen-agent', 'done', '2026-01-01T23:59:30.000Z'),
            event('older-unseen', 'seen-agent', 'blocked', '2026-01-01T23:58:30.000Z'),
        ], new Set(['seen']), now)).toEqual([]);
    });

    it('acknowledges only fully visible cards on a focused foreground Herd screen', () => {
        const rows: RecentActivityRow[] = [
            {
                eventId: 'first-event',
                sessionId: 'first',
                taskTitle: 'First task',
                agentName: 'Otter',
                status: 'done',
                reasonCode: 'state-reconciled',
                at: 100,
            },
            {
                eventId: 'second-event',
                sessionId: 'second',
                taskTitle: 'Second task',
                agentName: 'Badger',
                status: 'blocked',
                reasonCode: 'state-reconciled',
                at: 200,
            },
        ];
        const cards = [card('first', 100, 'done'), card('second', 200, 'blocked')];
        const viewport = {
            focused: true,
            foreground: true,
            viewportTop: 80,
            viewportBottom: 500,
            stripTop: 100,
            stripHeight: 200,
            scrollX: 0,
            stripWidth: 390,
            cardWidth: 300,
            cardGap: 12,
            gutter: 16,
        };

        expect(visibleActivityEventIds(rows, cards, viewport)).toEqual(['first-event']);
        expect(visibleActivityEventIds(rows, cards, { ...viewport, focused: false })).toEqual([]);
        expect(visibleActivityEventIds(rows, cards, { ...viewport, foreground: false })).toEqual([]);
        expect(visibleActivityEventIds(rows, cards, { ...viewport, stripTop: 79 })).toEqual([]);
        expect(visibleActivityEventIds(rows, cards, { ...viewport, stripTop: 349 })).toEqual([]);
        expect(visibleActivityEventIds(rows, cards, { ...viewport, scrollX: 20 })).toEqual([]);
    });

    it('keeps terminal swipe navigation on active and two-minute-recent agents', () => {
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
