import { herdPanes } from './herd';
import { selectLiveTerminalCards } from '../application/liveTerminalOrder';
import { describe, expect, it, vi } from 'vitest';
import { buildSpaceRows, middleTruncate, parentOf, spaceExpansionDefaults, workspaceName } from './herdTree';
import type { HerdrTreePane as ContractPane, HerdrTreeTab, HerdrTreeWorkspace as ContractWorkspace } from '@muxr/contract';
import { agentIdentityLine, agentKindLabel, agentLabels, agentNameLine, isShellLabels } from './agentPresentation';

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
        expect(agentNameLine(labels)).toBe('pi/Maria');
        expect(agentIdentityLine(labels)).toBe('pi/Maria');
        expect(agentLabels(pane('p-review', 'codex', { agentName: 'opus-review' }))).toMatchObject({
            taskTitle: 'opus-review',
            agentName: 'opus-review',
            agentKind: 'codex',
        });
        expect(agentNameLine(agentLabels(pane('p-review', 'codex', { agentName: 'opus-review' })))).toBe('codex');
        expect(agentNameLine(agentLabels(pane('p-fox', 'pi', { agentName: 'fox', taskTitle: 'Cursor Local Fast On' })))).toBe('pi/fox');
        expect(agentKindLabel('opencode')).toBe('OpenCode');
        expect(agentKindLabel('pi')).toBe('Pi');
        expect(agentLabels(pane('p-unnamed', 'opencode'))).toMatchObject({
            taskTitle: 'Unnamed agent',
            agentName: 'Unnamed agent',
            agentKind: 'opencode',
        });
        expect(agentLabels(shell)).toMatchObject({ taskTitle: 'tmp', agentName: 'Shell' });
        const titledShell = agentLabels(pane('p-titled-shell', undefined, { taskTitle: 'vim ~/.bashrc' }));
        expect(titledShell).toMatchObject({ taskTitle: 'vim ~/.bashrc', agentName: 'Shell' });
        expect(isShellLabels(titledShell)).toBe(true);
        const namedShell = pane('p-named', undefined, { sessionId: 'shell-route', label: 'Release browser', terminalTitle: 'umer@host:~/repo', cwd: '/repo' });
        expect(agentLabels(namedShell)).toMatchObject({ taskTitle: 'Release browser', agentName: 'Shell' });
        expect(agentNameLine(agentLabels(namedShell))).toBe('Shell');
        delete namedShell.label;
        expect(agentLabels(namedShell).taskTitle).toBe('umer@host:~/repo');
        const liveCards = selectLiveTerminalCards([], herdPanes([], [ws('w-shell', 'repo', [tab('t-shell', 'Tools', [namedShell])])]));
        expect(liveCards).toEqual([]);
        expect(agentLabels({ ...agent, terminalTitle: 'Animated working title' }).taskTitle).toBe('Review monitoring stability');
        expect(isShellLabels(labels)).toBe(false);
        expect(buildSpaceRows([ws('w2', 'repo-b', [tab('1', undefined, [shell])])], new Set(), '')[0])
            .toMatchObject({ agentCount: 0, expanded: false });
    });

    it('groups task workspaces behind their parent from declared lineage, never the label', () => {
        const mine = ws('w1', 'firstmate', [tab('t1', 'main', [agent])]);
        const byToken = { ...ws('w2', '└ opencode-extdir1 · p:8NwSBmQ5YerlAcFOBfSrqg', [tab('t2', undefined, [pane('p2', 'opencode', { agentName: 'donkey', agentStatus: 'idle' })])]), tokens: { parent: 'w1', kind: 'task' }, order: 2 };
        const byWorktree = { ...ws('w3', 'pock-design-system1', [tab('t3', undefined, [pane('p3', 'pi', { agentName: 'lemur', agentStatus: 'working' })])]), worktree: { repo: 'pockit', path: '/srv/wt/pock-design-system1', repoKey: 'pockit', linked: true }, order: 3 };
        const orphan = { ...ws('w4', 'closed-parent-task1', [tab('t4', undefined, [pane('p4', 'pi', { agentStatus: 'blocked' })])]), tokens: { parent: 'w-gone', kind: 'task' }, order: 4 };
        const shellWorkspace = { ...ws('w5', '/home/umer', [tab('t5', undefined, [shell])]), order: 5 };
        const workspaces = [shellWorkspace, orphan, byWorktree, byToken, mine];
        const byId = new Map(workspaces.map((entry) => [entry.workspaceId, entry] as const));
        expect(parentOf(byToken, byId)).toBe('w1');
        expect(parentOf(byWorktree, byId)).toBe(undefined);
        const primary = workspaces.find((entry) => entry.workspaceId === 'w1');
        const primaryWithWorktree = { ...primary!, worktree: { repo: 'pockit', path: '/home/umer/pockit', repoKey: 'pockit', linked: false } };
        const grouped = new Map([...byId, ['w1', primaryWithWorktree] as const]);
        expect(parentOf(byWorktree, grouped)).toBe('w1');

        const rows = buildSpaceRows(workspaces.map((entry) => entry.workspaceId === 'w1' ? primaryWithWorktree : entry), new Set(['w1', 'group:w1']), '');
        expect(rows).toHaveLength(3);
        const [orphanRow, shells, card] = rows;
        expect(card!.workspace.workspaceId).toBe('w1');
        expect(card!.children.map((child) => child.workspace.workspaceId)).toEqual(['w2', 'w3']);
        expect(card!.groupExpanded).toBe(true);
        expect(card!.agentCount).toBe(1);
        expect(shells!.children).toEqual([]);
        expect(shells!.workspace.workspaceId).toBe('w5');
        // The orphan's parent points outside the tree: it stays top-level.
        expect(orphanRow!.workspace.workspaceId).toBe('w4');
        expect(orphanRow!.children).toEqual([]);
        const flat = buildSpaceRows([orphan, mine], new Set(), '');
        expect(flat).toHaveLength(2);
        expect(flat[1]!.children).toEqual([]);

        // Search: a matching child keeps its parent, whose card opens with the group open.
        const searched = buildSpaceRows(workspaces.map((entry) => entry.workspaceId === 'w1' ? primaryWithWorktree : entry), new Set(), 'extdir');
        expect(searched).toHaveLength(1);
        expect(searched[0]!.workspace.workspaceId).toBe('w1');
        expect(searched[0]!.groupExpanded).toBe(true);
        expect(searched[0]!.children.map((child) => child.workspace.workspaceId)).toEqual(['w2']);
        expect(searched[0]!.panes).toEqual([]);
        expect(buildSpaceRows(workspaces, new Set(), 'nimbus')).toEqual([]);
        // The sheet seeds: a child opens its parent card and the group instead of itself.
        expect(spaceExpansionDefaults(workspaces, 'w2')).toEqual(['w1', 'group:w1']);
        expect(spaceExpansionDefaults(workspaces, 'w5')).toEqual(['w5']);
    });

    it('shows herdr workspace labels verbatim and truncates long paths in the path UI', () => {
        expect(workspaceName({ workspaceId: 'w1', label: '/home/umer/repo-a', focused: false, agentStatus: 'idle', tabs: [] } as ContractWorkspace)).toBe('/home/umer/repo-a');
        expect(workspaceName({ workspaceId: 'w2', label: undefined, focused: false, agentStatus: 'idle', tabs: [] } as ContractWorkspace)).toBe('w2');
        expect(middleTruncate('short')).toBe('short');
        expect(middleTruncate('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', 20)).toBe('abcdefghi…rstuvwxyz');
    });
});

const installedBuild = vi.hoisted(() => ({ version: '0.1.26' as string | null, build: '356' as string | null }));
vi.mock('expo-application', () => ({ get nativeApplicationVersion() { return installedBuild.version; }, get nativeBuildVersion() { return installedBuild.build; } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.12' } } }));
import { getAppVersion, getAppBuildNumber } from '@/utils/appVersion';
import { versionsMismatch } from '@/utils/versionStatus';

it('reports installed app and host versions without confusing stale Expo metadata or release channels', () => {
    expect(getAppVersion()).toBe('0.1.26');
    expect(getAppBuildNumber()).toBe('356');
    expect(versionsMismatch(getAppVersion(), '0.1.26')).toBe(false);
    expect(versionsMismatch(getAppVersion(), '0.1.27-beta.1')).toBe(true);
    expect(versionsMismatch('0.1.27', '0.1.27-beta.1')).toBe(false);
    expect(versionsMismatch(getAppVersion(), 'muxr')).toBe(false);
    try {
        installedBuild.version = null; installedBuild.build = null;
        expect(getAppVersion()).toBe('0.1.12');
        expect(getAppBuildNumber()).toBeUndefined();
    } finally { installedBuild.version = '0.1.26'; installedBuild.build = '356'; }
});
