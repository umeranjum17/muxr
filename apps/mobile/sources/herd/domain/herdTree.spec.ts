import { expect, it, vi } from 'vitest';
import { buildSpaceRows, checkoutDisclosureKey, workspaceName } from './herdTree';
import type { HerdrTreePane as ContractPane, HerdrTreeTab, HerdrTreeWorkspace as ContractWorkspace } from '@muxr/contract';

const pane = (id: string, agentKind?: string, extra: Partial<ContractPane> = {}): ContractPane => ({ paneId: id, tabId: 't1', agentStatus: 'idle', promptable: false, focused: false, agentKind, ...extra });
const ws = (id: string, label: string | undefined, tabs: HerdrTreeTab[]): ContractWorkspace => ({ workspaceId: id, label, focused: false, agentStatus: 'idle', tabs });
const tab = (tabId: string, label: string | undefined, panes: ContractPane[]): HerdrTreeTab => ({ tabId, label, focused: false, agentStatus: 'idle', panes });
const shell = pane('p-s', undefined, { cwd: '/tmp' });

it('navigates a mixed live tree by canonical repository and checkout, keeping search and selection paths', () => {
    const now = 1_000_000;
    const checkout = (id: string, label: string, repoKey: string, checkoutKey: string, branch: string, agentPane: ContractPane): ContractWorkspace => ({
        ...ws(id, label, [tab(`${id}-tab`, undefined, [agentPane])]),
        worktree: { repo: 'pockit', repoKey, repoPath: repoKey.slice(0, -5), checkoutKey, path: checkoutKey, branch, isLinkedWorktree: true },
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
