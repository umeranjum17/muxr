import { describe, expect, it } from 'vitest';
import type { HerdrTreeWorkspace } from '@muxr/contract';
import { herdDigest, herdNotificationState, paneStatus, sortHerd } from './herd';
import type { Session } from '@/catalog';

const pane = (id: string, overrides: Partial<Session> = {}): Session => ({
    id,
    presence: 'online',
    metadata: { summary: { text: id, updatedAt: 0 } },
    ...overrides,
} as Session);

const tree = (statuses: Record<string, 'working' | 'blocked' | 'done'>): HerdrTreeWorkspace[] => [{
    workspaceId: 'workspace',
    focused: true,
    agentStatus: 'blocked',
    tabs: [{
        tabId: 'tab',
        focused: true,
        agentStatus: 'blocked',
        panes: Object.entries(statuses).map(([sessionId, agentStatus]) => ({
            paneId: `pane-${sessionId}`,
            tabId: 'tab',
            sessionId,
            agentKind: 'pi',
            displayName: { docs: 'Dana', host: 'John', mobile: 'Maria', busy: 'Sam' }[sessionId],
            taskTitle: { docs: 'Write docs', host: 'Repair host', mobile: 'Fix mobile', busy: 'Build mobile' }[sessionId],
            agentStatus,
            terminalTitle: sessionId === 'mobile' ? 'npm test' : undefined,
            focused: false,
        })),
    }],
}];

describe('spoken herd flow', () => {
    it('sorts canonical panes by urgency and produces an honest digest', () => {
        const panes = sortHerd([
            pane('docs'),
            pane('host'),
            pane('mobile'),
            pane('busy'),
            pane('dead', { presence: 1_700_000_000 }),
        ], tree({ docs: 'done', host: 'working', mobile: 'blocked', busy: 'working' }));
        expect(panes.map((item) => item.id)).toEqual(['mobile', 'busy', 'host', 'docs']);
        expect(panes.map(({ name, taskTitle }) => ({ name, taskTitle }))).toEqual([
            { name: 'Maria', taskTitle: 'Fix mobile' },
            { name: 'Sam', taskTitle: 'Build mobile' },
            { name: 'John', taskTitle: 'Repair host' },
            { name: 'Dana', taskTitle: 'Write docs' },
        ]);
        expect(paneStatus(pane('stale', {
            metadata: { summary: { text: 'stale', updatedAt: 0 }, agentStatus: 'done' },
            thinking: true,
        } as Partial<Session>))).toBe('working');
        expect(herdDigest(panes)).toContain('Maria — needs you: Fix mobile');
        expect(herdDigest(panes)).not.toContain('npm test');
        expect(herdDigest([])).toContain('Nothing is running');
        expect(herdNotificationState(panes, 'connected')).toMatchObject({
            mode: 'attention', count: 1, name: 'Maria', eventKey: `attention:${encodeURIComponent('mobile')}`,
        });
        expect(JSON.stringify(herdNotificationState(panes, 'connected'))).not.toContain('npm test');
        expect(herdNotificationState(panes.filter((item) => item.status !== 'blocked'), 'connected')).toMatchObject({
            mode: 'working', count: 2, name: 'Sam', names: 'Sam, John',
        });
        expect(herdNotificationState([], 'connected').mode).toBe('idle');
        expect(herdNotificationState([], 'error').mode).toBe('offline');
    });
});
