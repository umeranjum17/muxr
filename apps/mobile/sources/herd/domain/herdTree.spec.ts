import { describe, expect, it } from 'vitest';
import { buildSpaceRows, middleTruncate, workspaceName } from './herdTree';
import type { HerdrTreePane as ContractPane, HerdrTreeTab, HerdrTreeWorkspace as ContractWorkspace } from '@muxr/contract';
import { agentLabels } from './agentPresentation';

const pane = (id: string, agentKind?: string, extra: Partial<ContractPane> = {}): ContractPane => ({ paneId: id, tabId: 't1', agentStatus: 'idle', promptable: false, focused: false, agentKind, ...extra });
const ws = (id: string, label: string | undefined, tabs: HerdrTreeTab[]): ContractWorkspace => ({ workspaceId: id, label, focused: false, agentStatus: 'idle', tabs });
const tab = (tabId: string, label: string | undefined, panes: ContractPane[]): HerdrTreeTab => ({ tabId, label, focused: false, agentStatus: 'idle', panes });
const agent = pane('p-a', 'pi', {
    sessionId: 's-a',
    cwd: '/home/umer/proj',
    agentName: 'Maria',
    taskTitle: 'Review monitoring stability',
});
const shell = pane('p-s', undefined, { cwd: '/tmp' });

describe('visible herd tree flow', () => {
    it('expands, collapses, and filters workspace cards without losing shell panes', () => {
        const workspaces = [ws('w1', 'repo-a', [tab('7', 'review', [agent, shell])])];
        const expanded = buildSpaceRows(workspaces, new Set(['w1']), '');
        expect(expanded).toHaveLength(1);
        expect(expanded[0]).toMatchObject({ type: 'workspace', agentCount: 1, expanded: true, panes: [agent, shell] });
        expect(buildSpaceRows(workspaces, new Set(), '')[0]).toMatchObject({ expanded: false, panes: [] });
        expect(buildSpaceRows(workspaces, new Set(['w1']), 'review monitoring')).toHaveLength(1);
        expect(buildSpaceRows(workspaces, new Set(['w1']), 'maria')).toHaveLength(1);
        expect(buildSpaceRows(workspaces, new Set(['w1']), 'beta')).toEqual([]);
        const labels = agentLabels(agent);
        expect({ primary: labels.taskTitle, secondary: labels.agentName, kind: labels.agentKind })
            .toEqual({ primary: 'Review monitoring stability', secondary: 'Maria', kind: 'pi' });
        expect(labels.taskTitle).not.toContain(labels.agentName);
        expect(agentLabels(shell)).toMatchObject({ taskTitle: 'Untitled task', agentName: 'Shell' });
        expect(buildSpaceRows([ws('w2', 'repo-b', [tab('1', undefined, [shell])])], new Set(), '')[0])
            .toMatchObject({ agentCount: 0, expanded: false });
    });

    it('keeps workspace labels readable in the card and path UI', () => {
        expect(workspaceName({ workspaceId: 'w1', label: '/home/umer/repo-a', focused: false, agentStatus: 'idle', tabs: [] } as ContractWorkspace)).toBe('repo-a');
        expect(workspaceName({ workspaceId: 'w2', label: undefined, focused: false, agentStatus: 'idle', tabs: [] } as ContractWorkspace)).toBe('w2');
        expect(middleTruncate('short')).toBe('short');
        expect(middleTruncate('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', 20)).toBe('abcdefghi…rstuvwxyz');
    });
});
