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
    status: LiveTerminalOrderCard['agentStatus'],
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
    status: LiveTerminalOrderCard['agentStatus'],
    createdAt = changedAt,
): LiveTerminalOrderCard {
    return { id, session: session(id, changedAt, status, createdAt), agentStatus: status, taskTitle: id, agentName: 'Otter', agentKind: 'pi', promptable: true, changedAt, createdAt };
}

describe('agent lifecycle presentation', () => {
    it('keeps terminal slots in creation order across lifecycle changes and old completions', () => {
        const cards = orderLiveTerminalCards([
            card('done', 900, 'done', 100),
            card('blocked', 800, 'blocked', 300),
            card('working', 1_000, 'working', 200),
        ]);

        expect(cards.map((item) => item.id)).toEqual(['done', 'working', 'blocked']);
        expect(orderLiveTerminalCards(cards.map((item) => ({ ...item, agentStatus: 'done' })))
            .map((item) => item.id)).toEqual(['done', 'working', 'blocked']);
    });

    it('keeps terminal slots stable through catalog joins and equivalent snapshots', () => {
        const pane = (id: string, status: HerdPane['agentStatus'], changedAt?: number): HerdPane => ({
            id,
            agentName: `${id} agent`,
            taskTitle: `${id} task`,
            agentKind: 'pi',
            agentStatus: status,
            promptable: true,
            changedAt,
            doing: '',
        });
        const treeOnly = selectLiveTerminalCards([], [pane('first', 'working', 100), pane('second', 'blocked')]);
        expect(treeOnly.map((item) => [item.id, item.session])).toEqual([
            ['first', undefined],
            ['second', undefined],
        ]);
        expect(agentStateLabel(treeOnly[1]!.agentStatus, treeOnly[1]!.changedAt, 1_000_000)).toBe('Needs you');
        expect(agentLabels(treeOnly[0]).agentName).toBe('first agent');

        const shell = selectLiveTerminalCards([], [{
            id: 'shell',
            agentStatus: 'unknown',
            promptable: false,
            doing: '',
        }])[0]!;
        const shellLabels = agentLabels(shell);
        expect(shellLabels).toMatchObject({ taskTitle: 'Untitled task', agentName: 'Shell' });
        expect(agentAccessibilityLabel(shellLabels, shell.agentStatus, shell.changedAt)).toBe('Untitled task. Offline. Shell');

        const pending = session('pending', 300, 'starting');
        pending.metadata!.agentKind = 'omp';
        Object.assign(pending.metadata!, { agentName: 'Stale Otter', taskTitle: 'Stale task' });
        expect(agentLabels()).toMatchObject({
            taskTitle: 'Untitled task',
            agentName: 'Shell',
        });

        const joined = reconcileLiveTerminalCards(treeOnly, selectLiveTerminalCards([
            session('second', 200, 'done', 20),
            session('first', 200, 'blocked', 10),
        ], [pane('first', 'blocked', 200), pane('second', 'done', 200)]));
        expect(joined.map((item) => [item.id, item.agentStatus, item.session?.id])).toEqual([
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
            agentKind: 'codex',
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

        expect(rows.map((row) => [row.eventId, row.sessionId, row.agentName, row.agentKind, row.status])).toEqual([
            ['latest', 'one', 'Otter', 'codex', 'done'],
            ['failed', 'four', 'Otter', 'codex', 'failed'],
        ]);
        const namedAsTitle = event('named', 'five', 'done', '2026-01-01T23:55:00.000Z');
        namedAsTitle.taskTitle = 'Otter';
        expect(unseenActivityRows([namedAsTitle], new Set(), now, 8, new Map([['five', 'Fix realtime voice']]))[0]?.taskTitle)
            .toBe('Fix realtime voice');

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
