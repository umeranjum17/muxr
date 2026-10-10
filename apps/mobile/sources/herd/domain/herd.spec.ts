import { describe, expect, it, vi } from 'vitest';
import { status } from '@byokit/statusbar';
import { refreshStatusChip } from '../application/refreshStatusChip';
import type { HerdrTreeWorkspace } from '@trymuxr/contract';
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
        // A Codex and a pi agent that have not published a name yet: Herdr ships
        // its internal launch id as `agentName`, and it must never be the label.
        for (const [kind, label, id] of [['codex', 'Codex', `pp_${'9c526c448bbeb98f'}`], ['pi', 'Pi', `pph_${'6ba0c0cdd02bca79'}`]] as const) {
            const fresh = agentLabels({ ...base, agentKind: kind, agentName: id });
            expect([fresh.title, agentWhoLine(fresh), agentBesideName(fresh) ?? '']).toEqual([label, kind, '']);
        }
        // The id can also ride a pane label or window title; it still says nothing.
        expect(agentLabels({ ...base, agentKind: 'pi', agentName: 'pp_1', label: 'pp_2', terminalTitle: 'pph_3', taskTitle: 'pp_4' }).title)
            .toBe('Pi');
    });
});


it('refreshes BYOKit busy counts from the herd and clears when its work ends', () => {
    const show = vi.spyOn(status, 'show');
    const clear = vi.spyOn(status, 'clear');
    const sessions = [pane('host'), pane('busy')];
    const refresh = (statuses: Record<string, 'working' | 'done'>) => {
        const agents = sortHerd(sessions, tree(statuses));
        return refreshStatusChip({
            herd: herdNotificationState(agents, 'connected'),
            agents: agents.map((agent) => ({ id: agent.id, name: agent.agentName ?? '', status: agent.agentStatus, focused: false })),
            voiceState: 'disconnected', voiceName: '', muted: false, voiceGeneration: 0,
        });
    };
    try {
        expect(refresh({ host: 'working', busy: 'working' }).active).toBe(true);
        expect(show).toHaveBeenLastCalledWith(expect.objectContaining({
            title: '2 agents working', chip: '2 busy', publicText: '2 agents working',
            actions: [{ id: 'talk', label: 'Talk' }], promote: true,
        }));
        expect(clear).not.toHaveBeenCalled();
        refresh({ host: 'done', busy: 'working' });
        expect(show).toHaveBeenLastCalledWith(expect.objectContaining({
            title: 'Sam is working', chip: '1 busy', publicText: '1 agent working',
        }));
        expect(refresh({ host: 'done', busy: 'done' }).active).toBe(false);
        expect(clear).toHaveBeenCalledOnce();
        expect(show).toHaveBeenCalledTimes(2);
    } finally {
        vi.restoreAllMocks();
    }
});
