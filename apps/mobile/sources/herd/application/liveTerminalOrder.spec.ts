import { describe, expect, it, vi } from 'vitest';
import type { LifecycleEvent } from '@muxr/contract';
import type { Session } from '@/catalog';
import type { HerdPane } from '../domain/herd';
import { agentAccessibilityLabel, agentLabels, agentStateLabel, liveCardState } from '../domain/agentPresentation';
import { lifecycleStateSince, unseenActivityRows, unseenDoneSessionIds, type RecentActivityRow } from '../domain/recentActivity';
import {
    agentSwipeNeighbours,
    arrangeLiveTerminalCards,
    EMPTY_LIVE_TERMINAL_ARRANGEMENT,
    LIVE_WORKING_DWELL_MS,
    liveTerminalOrderSettlesAt,
    selectLiveTerminalCards,
    sharedLiveTerminalCards,
    visibleActivityEventIds,
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
    it('leads with needs-you then working agents, without flapping, racing or moving under a finger', () => {
        let arrangement = EMPTY_LIVE_TERMINAL_ARRANGEMENT;
        const frame = (now: number, cards: LiveTerminalOrderCard[], held = false) => {
            arrangement = arrangeLiveTerminalCards(arrangement, cards, now, held);
            return arrangement.cards.map((item) => item.id);
        };
        // leopard was made first and sits idle; the busy ones lead.
        let now = 1_000;
        expect(frame(now, [
            card('leopard', 900, 'idle', 1),
            card('otter', 950, 'working', 2),
            card('badger', 990, 'working', 3),
            card('heron', 990, 'blocked', 4),
        ])).toEqual(['heron', 'otter', 'badger', 'leopard']);

        // Two agents streaming output never trade places, whatever changes per frame.
        for (let tick = 1; tick <= 20; tick += 1) {
            now += 500;
            expect(frame(now, [
                card('leopard', 900, 'idle', 1),
                card('otter', now - (tick % 2) * 400, 'working', 2),
                card('badger', now - ((tick + 1) % 2) * 400, 'working', 3),
                card('heron', 990, 'blocked', 4),
            ])).toEqual(['heron', 'otter', 'badger', 'leopard']);
        }

        // A pause between tool calls does not bounce otter out of the lead...
        const pause = now;
        const quiet = [card('leopard', 900, 'idle', 1), card('otter', pause, 'idle', 2), card('badger', now, 'working', 3), card('heron', 990, 'working', 4)];
        expect(frame(now, quiet)).toEqual(['otter', 'badger', 'heron', 'leopard']);
        expect(liveTerminalOrderSettlesAt(arrangement)).toBe(pause + LIVE_WORKING_DWELL_MS);
        now += LIVE_WORKING_DWELL_MS - 1;
        expect(frame(now, quiet)).toEqual(['otter', 'badger', 'heron', 'leopard']);
        // ...and resuming keeps its place in the queue rather than rejoining the back.
        now += 1;
        expect(frame(now, [card('leopard', 900, 'idle', 1), card('otter', now, 'working', 2), card('badger', now, 'working', 3), card('heron', 990, 'working', 4)]))
            .toEqual(['otter', 'badger', 'heron', 'leopard']);
        expect(liveTerminalOrderSettlesAt(arrangement)).toBeUndefined();

        // Staying quiet past the dwell hands otter back its home slot among the rest.
        const done = [card('leopard', 900, 'idle', 1), card('otter', now, 'done', 2), card('badger', now, 'working', 3), card('heron', 990, 'working', 4)];
        frame(now, done);
        now += LIVE_WORKING_DWELL_MS;
        expect(frame(now, done)).toEqual(['badger', 'heron', 'leopard', 'otter']);

        // Under a finger nothing moves: leopard starting waits, a newcomer joins the end,
        // a closed agent simply leaves. The order catches up when the hold lifts.
        const touched = [card('leopard', now, 'working', 1), card('otter', now, 'done', 2), card('badger', now, 'working', 3), card('kite', now, 'working', 5)];
        expect(frame(now, touched, true)).toEqual(['badger', 'leopard', 'otter', 'kite']);
        now += 3_000;
        expect(frame(now, touched)).toEqual(['badger', 'leopard', 'kite', 'otter']);
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

        expect(selectLiveTerminalCards([], [{
            id: 'shell',
            agentStatus: 'unknown',
            promptable: false,
            doing: '',
        }])).toEqual([]);
        const shellLabels = agentLabels();
        expect(shellLabels).toMatchObject({ taskTitle: 'Shell', agentName: 'Shell' });
        expect(agentAccessibilityLabel(shellLabels, 'unknown')).toBe('Shell. Offline. Shell');

        const pending = session('pending', 300, 'starting');
        pending.metadata!.agentKind = 'omp';
        Object.assign(pending.metadata!, { agentName: 'Stale Otter', taskTitle: 'Stale task' });
        expect(agentLabels()).toMatchObject({
            taskTitle: 'Shell',
            agentName: 'Shell',
        });

        const treeArranged = arrangeLiveTerminalCards(EMPTY_LIVE_TERMINAL_ARRANGEMENT, treeOnly, 0);
        const joinedArranged = arrangeLiveTerminalCards(treeArranged, selectLiveTerminalCards([
            session('second', 200, 'done', 20),
            session('first', 200, 'blocked', 10),
        ], [pane('first', 'blocked', 200), pane('second', 'done', 200)]), 0);
        const joined = joinedArranged.cards;
        expect(joined.map((item) => [item.id, item.agentStatus, item.session?.id])).toEqual([
            ['first', 'blocked', 'first'],
            ['second', 'done', 'second'],
        ]);
        const equivalent = selectLiveTerminalCards(
            joined.flatMap((item) => item.session === undefined ? [] : [item.session]),
            [pane('first', 'blocked', 200), pane('second', 'done', 200)],
        );
        expect(arrangeLiveTerminalCards(joinedArranged, equivalent, 0).cards).toBe(joined);
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

        // A card is aged from the same transition its row reads, not from when
        // this phone first saw the state: after a relaunch that was "now".
        const events = [
            event('latest', 'one', 'done', '2026-01-01T23:48:00.000Z'),
            event('earlier', 'one', 'working', '2026-01-01T23:40:00.000Z'),
            event('turn', 'two', 'working', '2026-01-01T23:56:00.000Z'),
        ];
        expect(agentStateLabel('done', lifecycleStateSince(events, 'one', 'done'), now)).toBe('Done · 12m');
        expect(agentStateLabel('idle', lifecycleStateSince(events, 'one', 'idle'), now)).toBe('Idle · 12m');
        expect(lifecycleStateSince(events, 'one', 'working')).toBeUndefined();
        expect(agentStateLabel('working', lifecycleStateSince(events, 'two', 'working'), now)).toBe('Working · 4m');
        expect(agentStateLabel('working', now - 20_000, now)).toBe('Working');
    });

    it('omits card age and accessible age after the transition is displaced before relaunch', () => {
        const now = Date.parse('2026-01-02T00:00:00.000Z');
        const finished: LifecycleEvent = {
            eventId: 'finished', sessionId: 'one', agentName: 'Otter', state: 'done',
            reasonCode: 'agent-done', at: new Date(now - 12 * 60_000).toISOString(),
        };
        const reopened = selectLiveTerminalCards([session('one', now - 5_000, 'done', now - 60 * 60_000)], [{
            id: 'one', taskTitle: 'Fix realtime voice', agentName: 'Otter', agentKind: 'pi',
            agentStatus: 'done', promptable: true, changedAt: now - 5_000, doing: '',
        }])[0]!;
        const labels = agentLabels(reopened);
        const withEvent = liveCardState(labels, reopened.agentStatus, reopened.id, [finished], now);
        expect(withEvent.label).toBe('Done · 12m');

        const displaced: LifecycleEvent[] = Array.from({ length: 50 }, (_, index) => ({
            ...finished, eventId: `later-${index}`, sessionId: `other-${index}`,
            at: new Date(now - index * 1_000).toISOString(),
        }));
        const afterRelaunch = liveCardState(labels, reopened.agentStatus, reopened.id, displaced, now);
        expect(afterRelaunch.label).toBe('Done');
        expect(afterRelaunch.accessibilityLabel).toBe('Otter. Done. Fix realtime voice · pi');

        const running: LifecycleEvent = {
            ...finished, eventId: 'running', state: 'working', at: new Date(now - 59_500).toISOString(),
        };
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
        try {
            const beforeTick = liveCardState(labels, 'working', reopened.id, [running], now);
            expect(beforeTick.label).toBe('Working');
            expect(beforeTick.accessibilityLabel).toBe('Otter. Working. Fix realtime voice · pi');
            const afterTick = liveCardState(labels, 'working', reopened.id, [running], now + 1_000);
            expect(afterTick.label).toBe('Working · 1m');
            expect(afterTick.accessibilityLabel).toBe('Otter. Working · 1m. Fix realtime voice · pi');
        } finally {
            clock.mockRestore();
        }
    });

    it('derives the unseen-done highlight set from the same rows as the tier', () => {
        const now = Date.parse('2026-01-02T00:00:00.000Z');
        const event = (eventId: string, sessionId: string, state: LifecycleEvent['state'], at: string): LifecycleEvent => ({
            eventId,
            sessionId,
            agentName: 'Otter',
            agentKind: 'codex',
            state,
            reasonCode: 'state-reconciled',
            at,
        });
        // Highlight and tier cannot disagree: one derivation, done rows only.
        // Newest first, the order the host catalog serves. A restart (three:
        // done then working) does not erase the missed outcome — the tier keeps
        // it until the agent is opened, so the highlight keeps it too.
        expect(unseenDoneSessionIds([
            event('working-again', 'three', 'working', '2026-01-01T23:59:30.000Z'),
            event('unseen-done', 'one', 'done', '2026-01-01T23:59:00.000Z'),
            event('seen-done', 'two', 'done', '2026-01-01T23:58:00.000Z'),
            event('restarted', 'three', 'done', '2026-01-01T23:57:00.000Z'),
            event('blocked', 'four', 'blocked', '2026-01-01T23:56:00.000Z'),
            event('old', 'five', 'done', '2025-12-31T23:00:00.000Z'),
        ], new Set(['seen-done']), now)).toEqual(new Set(['one', 'three']));
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

    it('pages the terminal swipe along the strip, stopping at active and two-minute-recent agents or at every agent', () => {
        const now = 300_000;
        const cards = [
            card('old', now - 120_001, 'done', 1),
            card('working', now - 5_000, 'working', 2),
            card('idle', now, 'idle', 3),
            card('recent', now - 30_000, 'done', 4),
            card('blocked', now, 'blocked', 5),
        ];
        const around = (id: string, from = cards, scope: 'working' | 'all' = 'working') => {
            const { previous, next } = agentSwipeNeighbours(from, id, scope, now);
            return [previous?.id, next?.id];
        };

        // The first agent is an end, not a wrap.
        expect(around('working')).toEqual([undefined, 'recent']);
        // Swiping back returns where it came from, whatever that agent did meanwhile.
        const settled = cards.map((item) => (item.id === 'working' ? { ...item, agentStatus: 'blocked' as const, changedAt: now } : item));
        expect(around('recent', settled)).toEqual(['working', 'blocked']);
        expect(around('blocked', [...cards, card('starting', now, 'starting', 6)])).toEqual(['recent', 'starting']);
        expect(around('shell:1')).toEqual(['blocked', 'working']);
        // Every agent: idle and long-finished agents are pages too.
        expect(around('working', cards, 'all')).toEqual(['old', 'idle']);

        sharedLiveTerminalCards([]);
        const treeOnly = sharedLiveTerminalCards([
            { ...card('first', now, 'working'), createdAt: undefined },
            { ...card('second', now, 'blocked'), createdAt: undefined },
        ]);
        const joined = sharedLiveTerminalCards([
            card('first', now, 'working', 20), card('second', now, 'blocked', 10),
        ]);
        expect(treeOnly.map((item) => item.id)).toEqual(['second', 'first']);
        expect(joined.map((item) => item.id)).toEqual(['second', 'first']);
        expect(agentSwipeNeighbours(joined, 'first', 'working', now).previous?.id).toBe('second');
        sharedLiveTerminalCards([]);
    });
});
