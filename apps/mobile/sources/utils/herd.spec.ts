import { describe, expect, it } from 'vitest';
import type { HerdrTreeWorkspace } from '@muxr/contract';
import { herdDigest, herdNotificationState, paneStatus, sortHerd } from './herd';
import type { Session } from '@/sync/storageTypes';

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
        expect(paneStatus(pane('stale', {
            metadata: { summary: { text: 'stale', updatedAt: 0 }, agentStatus: 'done' },
            thinking: true,
        } as Partial<Session>))).toBe('working');
        expect(herdDigest(panes)).toContain('mobile — needs you (npm test)');
        expect(herdDigest([])).toContain('Nothing is running');
        expect(herdNotificationState(panes, 'connected')).toMatchObject({
            mode: 'attention', count: 1, name: 'mobile', eventKey: `attention:${encodeURIComponent('mobile')}`,
        });
        expect(JSON.stringify(herdNotificationState(panes, 'connected'))).not.toContain('npm test');
        expect(herdNotificationState(panes.filter((item) => item.status !== 'blocked'), 'connected')).toMatchObject({
            mode: 'working', count: 2, name: 'busy', names: 'busy, host',
        });
        expect(herdNotificationState([], 'connected').mode).toBe('idle');
        expect(herdNotificationState([], 'error').mode).toBe('offline');
    });
});
