import { describe, expect, it } from 'vitest';
import type { HerdrTreeWorkspace } from '@muxr/contract';
import { herdDigest, herdNotificationState, paneStatus, sortHerd } from './herd';
import { agentBesideName, agentLabels, agentWhoLine } from './agentPresentation';
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
            agentName: { docs: 'Dana', host: 'John', mobile: 'Maria', busy: 'Sam' }[sessionId],
            taskTitle: { docs: 'Write docs', host: 'Repair host', mobile: 'Fix mobile', busy: 'Build mobile' }[sessionId],
            promptable: true,
            agentStatus,
            terminalTitle: sessionId === 'mobile' ? '✳ Claude Code' : undefined,
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
        expect(panes.map(({ agentName, taskTitle }) => ({ agentName, taskTitle }))).toEqual([
            { agentName: 'Maria', taskTitle: 'Fix mobile' },
            { agentName: 'Sam', taskTitle: 'Build mobile' },
            { agentName: 'John', taskTitle: 'Repair host' },
            { agentName: 'Dana', taskTitle: 'Write docs' },
        ]);
        expect(paneStatus(pane('stale', {
            metadata: { summary: { text: 'stale', updatedAt: 0 }, agentStatus: 'done' },
            thinking: true,
        } as Partial<Session>))).toBe('working');
        expect(herdDigest(panes)).toContain('Maria — needs you: Fix mobile');
        expect(herdDigest(panes)).not.toContain('Claude Code');
        expect(herdDigest([])).toContain('Nothing is running');
        expect(herdNotificationState(panes, 'connected')).toMatchObject({
            mode: 'attention', count: 1, name: 'Maria', eventKey: `attention:${encodeURIComponent('mobile')}`,
        });
        expect(JSON.stringify(herdNotificationState(panes, 'connected'))).not.toContain('Claude Code');
        expect(herdNotificationState(panes.filter((item) => item.agentStatus !== 'blocked'), 'connected')).toMatchObject({
            mode: 'working', count: 2, name: 'Sam', names: 'Sam, John',
        });
        expect(herdNotificationState([], 'connected').mode).toBe('idle');
        expect(herdNotificationState([], 'error').mode).toBe('offline');
    });

    it('leads every surface with what the agent is working on, and says who under it', () => {
        const base = { paneId: 'p', tabId: 't', focused: false, promptable: true, agentStatus: 'working' as const, cwd: '/home/u/pockit' };
        const lines = (labels: ReturnType<typeof agentLabels>) => [labels.title, agentWhoLine(labels), agentBesideName(labels)];
        // Every source only names the repo or the program: the name leads, nothing repeats it.
        expect(lines(agentLabels({ ...base, agentKind: 'pi', agentName: 'lima', taskTitle: 'Pockit', terminalTitle: 'π - pockit' })))
            .toEqual(['lima', 'pi', undefined]);
        // Claude's own session topic beats a clumsy first-prompt title.
        expect(lines(agentLabels({ ...base, agentKind: 'claude', agentName: 'yankee', taskTitle: 'Fix nothing just tell me', terminalTitle: 'agentHandle function behavior' })))
            .toEqual(['agentHandle function behavior', 'claude · yankee', 'yankee']);
        // A title someone set on the pane beats everything.
        expect(agentLabels({ ...base, agentKind: 'claude', agentName: 'yankee', label: 'Fix login redirect', terminalTitle: 'agentHandle function behavior' }).title)
            .toBe('Fix login redirect');
        // A named pi session keeps its name and drops the folder.
        expect(agentLabels({ ...base, agentKind: 'pi', agentName: 'zulu-2', terminalTitle: 'π - fix rows - pockit' }).title).toBe('fix rows');
        // The host folds in a task workspace's label when nothing better exists.
        expect(lines(agentLabels({ ...base, agentKind: 'codex', agentName: 'uniform', taskTitle: 'pock-preview-presence1', terminalTitle: 'pockit' })))
            .toEqual(['pock-preview-presence1', 'codex · uniform', 'uniform']);
        // A plain shell keeps what the shell says about itself.
        const shell = agentLabels({ ...base, agentStatus: 'unknown', terminalTitle: 'u@host:~/pockit' });
        expect([shell.title, agentWhoLine(shell)]).toEqual(['u@host:~/pockit', 'Shell']);
    });
});
