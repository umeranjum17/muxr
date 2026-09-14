import { expect, it, vi } from 'vitest';
import { buildSpaceRows, checkoutDisclosureKey, workspaceName } from './herdTree';
import type { HerdrTreePane as ContractPane, HerdrTreeTab, HerdrTreeWorkspace as ContractWorkspace } from '@muxr/contract';

const pane = (id: string, agentKind?: string, extra: Partial<ContractPane> = {}): ContractPane => ({ paneId: id, tabId: 't1', agentStatus: 'idle', promptable: false, focused: false, agentKind, ...extra });
const ws = (id: string, label: string | undefined, tabs: HerdrTreeTab[]): ContractWorkspace => ({ workspaceId: id, label, focused: false, agentStatus: 'idle', tabs });
const tab = (tabId: string, label: string | undefined, panes: ContractPane[]): HerdrTreeTab => ({ tabId, label, focused: false, agentStatus: 'idle', panes });
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
    const blocked = checkout('w1', 'pock-gate1 · p:secret', '/work/pockit/.git', '/tree/gate/pockit', 'gate',
        pane('p1', 'pi', { sessionId: 'route-gate', agentName: 'Koala', agentStatus: 'blocked', taskTitle: 'v1 launch-brief: repeated wrapper' }));
    const recent = checkout('w2', 'pock-view1 · p:secret', '/work/pockit/.git', '/tree/view/pockit', 'feature-branch',
        pane('p2', 'codex', { sessionId: 'route-view', agentName: 'Orca', agentStatus: 'done', changedAt: now - 1_000 }));
    const sameName = checkout('w3', 'other-pockit', '/other/pockit/.git', '/other/checkout', 'main',
        pane('p3', 'pi', { sessionId: 'route-other', agentName: 'Fox', agentStatus: 'working' }));
    const shellOnly = ws('w4', undefined, [tab('shell-tab', undefined, [shell])]);
    const workspaces = [recent, sameName, shellOnly, blocked];
    const rows = buildSpaceRows(workspaces, new Set([checkoutDisclosureKey('/work/pockit/.git', '/tree/gate/pockit')]), '', 'route-gate', now);
    const repos = rows.filter((row) => row.type === 'repository');
    expect(repos).toHaveLength(2);
    expect(repos[0]).toMatchObject({ title: 'pockit', totalWorktrees: 2, pathHint: '/work/pockit' });
    expect(repos[0]!.worktrees.map((row) => row.title)).toEqual(['pock-gate1', 'pock-view1']);
    expect(repos[0]!.counts).toMatchObject({ agents: 2, blocked: 1, recent: 1 });
    expect(repos[0]!.worktrees[0]).toMatchObject({ expanded: true, selected: true });
    expect(repos[1]).toMatchObject({ title: 'pockit', totalWorktrees: 1, pathHint: '/other/pockit' });
    expect(rows.find((row) => row.type === 'workspace')).toMatchObject({ counts: { agents: 0, shells: 1 } });
    expect(workspaceName(blocked)).toBe('pock-gate1');
    expect(workspaceName(shellOnly)).toBe('Untitled space');

    const searched = buildSpaceRows(workspaces, new Set(), 'feature-branch', undefined, now);
    expect(searched).toHaveLength(1);
    expect(searched[0]).toMatchObject({ type: 'repository', totalWorktrees: 2 });
    if (searched[0]?.type === 'repository') expect(searched[0].worktrees).toMatchObject([{ title: 'pock-view1', expanded: true, matchedPanes: 1 }]);
    expect(buildSpaceRows(workspaces, new Set(), 'koala', undefined, now)[0]).toMatchObject({ type: 'repository' });
    const workingInstead = { ...blocked, tabs: [tab('working-tab', undefined, [
        pane('working-pane', 'pi', { sessionId: 'working-route', agentStatus: 'working' }),
    ])] };
    const priority = buildSpaceRows([recent, workingInstead], new Set(), '', 'route-view', now)[0];
    if (priority?.type === 'repository') expect(priority.worktrees.map((row) => row.title)).toEqual(['pock-gate1', 'pock-view1']);
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
